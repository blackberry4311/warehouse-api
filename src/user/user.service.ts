import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import * as bcrypt from 'bcrypt';
import { User } from '../entities/user.entity';
import { CreditHistory } from '../entities/credit-history.entity';
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
  ) {}

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
