import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';
import * as bcrypt from 'bcrypt';
import { User } from '../entities/user.entity';
import { CreditHistory } from '../entities/credit-history.entity';
import { UserOrg } from '../entities/user-org.entity';
import { UpdateProfileDto } from './dto/update-profile.dto';
import { decodeCursor, parseLimit, toPage } from '../common/pagination.util';

/**
 * Self-service for the authenticated user: read/update their own profile and
 * review their own credit. Every method acts on the caller's own id (resolved
 * from the access token by the controller), so there is no cross-user
 * authorization to enforce here — the account IS the scope.
 */
@Injectable()
export class UserService {
  constructor(
    @InjectRepository(User) private userRepo: Repository<User>,
    @InjectRepository(CreditHistory) private creditHistoryRepo: Repository<CreditHistory>,
    @InjectRepository(UserOrg) private userOrgRepo: Repository<UserOrg>,
  ) {}

  /**
   * The global user directory — every non-admin user in the system — for an
   * administrator to find an existing account and (re-)assign it to an org, e.g.
   * after they were removed from one (there is otherwise no way to look up a user
   * you can no longer see via an org's member list). Gated by `manage_all_users`
   * (see PERMISSION_API_MAP); system admins are excluded from the results.
   *
   * Each row carries the orgs the user currently belongs to (`{ id, name }`) so
   * the frontend can show membership and offer the right add/remove actions
   * without a second round-trip. Safe columns only (never the password hash).
   * Optional `search` matches email, display name or client code
   * (case-insensitive). Newest first, keyset-paginated by `(created_at, id)` like
   * the other lists.
   */
  async listUsers(limitRaw?: string, cursor?: string, search?: string) {
    const limit = parseLimit(limitRaw);
    const qb = this.userRepo
      .createQueryBuilder('u')
      .select(['u.id', 'u.email', 'u.displayName', 'u.code', 'u.createdAt'])
      .where('u.isAdmin = false')
      .orderBy('u.createdAt', 'DESC')
      .addOrderBy('u.id', 'DESC')
      .take(limit + 1);

    const term = search?.trim();
    if (term) {
      qb.andWhere('(u.email ILIKE :term OR u.displayName ILIKE :term OR u.code ILIKE :term)', {
        term: `%${term}%`,
      });
    }

    if (cursor) {
      const { t, id } = decodeCursor(cursor);
      qb.andWhere('(u.createdAt < :t OR (u.createdAt = :t AND u.id < :id))', {
        t: new Date(t),
        id,
      });
    }

    const page = toPage(await qb.getMany(), limit);

    // Attach each user's org memberships in one extra query (keyed by the page's
    // user ids), then group them per user for the response.
    const userIds = page.items.map((u) => u.id);
    const memberships = userIds.length
      ? await this.userOrgRepo.find({
          where: { userId: In(userIds) },
          relations: { organization: true },
        })
      : [];

    const orgsByUser = new Map<string, { id: string; name: string }[]>();
    for (const m of memberships) {
      const list = orgsByUser.get(m.userId) ?? [];
      list.push({ id: m.orgId, name: m.organization.name });
      orgsByUser.set(m.userId, list);
    }

    const items = page.items.map((u) => ({
      id: u.id,
      email: u.email,
      displayName: u.displayName,
      code: u.code,
      createdAt: u.createdAt,
      organizations: orgsByUser.get(u.id) ?? [],
    }));

    return { items, nextCursor: page.nextCursor };
  }

  /** The caller's own profile (safe columns only — never the password hash). */
  async getProfile(userId: string) {
    const user = await this.ensureUserExists(userId);
    return this.toProfile(user);
  }

  /**
   * Update the caller's own profile. Only `displayName` / `password` are editable
   * (see UpdateProfileDto — `email` and `code` are intentionally not). Returns the
   * updated profile.
   */
  async updateProfile(userId: string, dto: UpdateProfileDto) {
    const user = await this.ensureUserExists(userId);

    if (dto.displayName !== undefined) user.displayName = dto.displayName;
    if (dto.password !== undefined) user.passwordHash = await bcrypt.hash(dto.password, 10);

    const saved = await this.userRepo.save(user);
    return this.toProfile(saved);
  }

  /**
   * The caller's credit at a glance: their current wallet balance plus their full
   * ledger across ALL orgs (the wallet is a single pool that spans orgs), newest
   * first and keyset-paginated by `(created_at, id)` — backed by the
   * `credit_history (user_id_fk, created_at desc, id desc)` index. Contrast with
   * `OrganizationService.getMemberCredit`, which scopes the ledger to one org for a
   * member-manager's view.
   */
  async getMyCredit(userId: string, limitRaw?: string, cursor?: string) {
    const user = await this.ensureUserExists(userId);

    const limit = parseLimit(limitRaw);
    const qb = this.creditHistoryRepo
      .createQueryBuilder('c')
      .where('c.userId = :userId', { userId })
      .orderBy('c.createdAt', 'DESC')
      .addOrderBy('c.id', 'DESC')
      .take(limit + 1);

    if (cursor) {
      const { t, id } = decodeCursor(cursor);
      qb.andWhere('(c.createdAt < :t OR (c.createdAt = :t AND c.id < :id))', {
        t: new Date(t),
        id,
      });
    }

    const history = toPage(await qb.getMany(), limit);
    return { userId: user.id, credit: user.credit, history };
  }

  private toProfile(user: User) {
    return {
      id: user.id,
      email: user.email,
      displayName: user.displayName,
      code: user.code,
      isAdmin: user.isAdmin,
      credit: user.credit,
      createdAt: user.createdAt,
      updatedAt: user.updatedAt,
    };
  }

  private async ensureUserExists(userId: string) {
    const user = await this.userRepo.findOne({ where: { id: userId } });
    if (!user) throw new NotFoundException('User not found');
    return user;
  }
}
