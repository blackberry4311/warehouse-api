import { BadRequestException, ForbiddenException, Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { ActivityAction, ActivityEntityType, ActivityLog } from '../entities/activity-log.entity';
import { OrganizationService } from '../organization/organization.service';
import { decodeCursor, Page, parseLimit, toPage } from '../common/pagination.util';

const ACTION_VALUES = new Set<string>(Object.values(ActivityAction));
const ENTITY_TYPE_VALUES = new Set<string>(Object.values(ActivityEntityType));

/** Raw query-string filters for the activity feed. */
export interface ActivityFilterQuery {
  action?: string;
  entityType?: string;
  entityId?: string;
  actorId?: string;
  subjectUserId?: string;
  from?: string;
  to?: string;
}

/** Parsed, validated activity-feed filters. */
export interface ActivityFilters {
  actions: ActivityAction[];
  entityType?: ActivityEntityType;
  entityId?: string;
  actorId?: string;
  subjectUserId?: string;
  from?: Date;
  to?: Date;
}

/**
 * Parse the feed filters: `action` is a comma-separated list (unknown values dropped,
 * like the ledger's `type`); `entityType` must be a known type (400 otherwise);
 * `from` is inclusive and `to` exclusive (400 if unparseable or `from >= to`).
 */
export function parseActivityFilters(raw: ActivityFilterQuery): ActivityFilters {
  const actions = (raw.action ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter((s) => ACTION_VALUES.has(s)) as ActivityAction[];

  let entityType: ActivityEntityType | undefined;
  if (raw.entityType) {
    if (!ENTITY_TYPE_VALUES.has(raw.entityType)) {
      throw new BadRequestException(
        `entityType must be one of ${[...ENTITY_TYPE_VALUES].join(', ')}`,
      );
    }
    entityType = raw.entityType as ActivityEntityType;
  }

  const from = parseDateBound(raw.from, 'from');
  const to = parseDateBound(raw.to, 'to');
  if (from && to && from >= to) throw new BadRequestException('from must be before to');

  return {
    actions,
    entityType,
    entityId: raw.entityId || undefined,
    actorId: raw.actorId || undefined,
    subjectUserId: raw.subjectUserId || undefined,
    from,
    to,
  };
}

function parseDateBound(raw: string | undefined, name: string): Date | undefined {
  if (raw === undefined || raw === '') return undefined;
  const date = new Date(raw);
  if (Number.isNaN(date.getTime())) throw new BadRequestException(`${name} must be a valid date`);
  return date;
}

/**
 * Read side of the system-wide activity feed (`activity_log`). Writes happen in the
 * feature services via `recordActivity`; this only lists.
 */
@Injectable()
export class ActivityService {
  constructor(
    @InjectRepository(ActivityLog) private activityRepo: Repository<ActivityLog>,
    private readonly orgService: OrganizationService,
  ) {}

  /**
   * List an org's activity, newest first, keyset-paginated by (created_at, id). The
   * route is gated by `view_activity_log` in `PERMISSION_API_MAP`; here we re-check
   * that the caller belongs to **this** org and holds the permission **in it**
   * (admins pass both), so a grant in one org can't read another's feed. Each row
   * joins `actor` / `subjectUser` with safe columns only.
   */
  async listActivity(
    userId: string,
    orgId: string,
    filters: ActivityFilters,
    limitRaw?: string,
    cursor?: string,
  ): Promise<Page<ActivityLog>> {
    await this.orgService.getOrganization(orgId);
    await this.orgService.assertOrgMembership(orgId, userId);
    if (!(await this.orgService.hasOrgPermission(orgId, userId, 'view_activity_log'))) {
      throw new ForbiddenException('You cannot view the activity log of this organization');
    }

    const limit = parseLimit(limitRaw);
    const qb = this.activityRepo
      .createQueryBuilder('a')
      .leftJoin('a.actor', 'actor')
      .addSelect(['actor.id', 'actor.email', 'actor.displayName', 'actor.code'])
      .leftJoin('a.subjectUser', 'subject')
      .addSelect(['subject.id', 'subject.email', 'subject.displayName', 'subject.code'])
      .where('a.orgId = :orgId', { orgId })
      .orderBy('a.createdAt', 'DESC')
      .addOrderBy('a.id', 'DESC')
      .take(limit + 1);

    if (filters.actions.length > 0) {
      qb.andWhere('a.action IN (:...actions)', { actions: filters.actions });
    }
    if (filters.entityType) qb.andWhere('a.entityType = :entityType', filters);
    if (filters.entityId) qb.andWhere('a.entityId = :entityId', filters);
    if (filters.actorId) qb.andWhere('a.actorId = :actorId', filters);
    if (filters.subjectUserId) qb.andWhere('a.subjectUserId = :subjectUserId', filters);
    if (filters.from) qb.andWhere('a.createdAt >= :from', filters);
    if (filters.to) qb.andWhere('a.createdAt < :to', filters);

    if (cursor) {
      const { t, id } = decodeCursor(cursor);
      qb.andWhere('(a.createdAt < :t OR (a.createdAt = :t AND a.id < :curId))', {
        t: new Date(t),
        curId: id,
      });
    }

    return toPage(await qb.getMany(), limit);
  }
}
