import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { EntityManager, In, IsNull, LessThan, Repository } from 'typeorm';
import { ActivityAction, ActivityLog } from '../entities/activity-log.entity';
import { Notification } from '../entities/notification.entity';
import { decodeCursor, Page, parseLimit, toPage } from '../common/pagination.util';

/**
 * Which staff hear about an action, by the permission they hold **in the action's
 * org**: new orders/shipments go to the reviewers' queue, locked ones to operations.
 * Users are resolved from their groups, so system admins (who hold everything
 * implicitly, not via groups) are not spammed. Extend this map to notify more roles.
 */
const STAFF_RECIPIENTS: Partial<Record<ActivityAction, string[]>> = {
  [ActivityAction.ORDER_PLACED]: ['review_order'],
  [ActivityAction.SHIPMENT_PLACED]: ['review_shipment'],
  [ActivityAction.ORDER_LOCKED]: ['process_order'],
  [ActivityAction.SHIPMENT_LOCKED]: ['process_shipment'],
};

/** Activity rows younger than this are left to the event listener, not the sweep. */
const SWEEP_GRACE_MS = 30_000;
const SWEEP_BATCH = 200;

export interface NotificationFilters {
  orgId?: string;
  unread?: boolean;
}

/** One inbox row: the notification's read state plus the activity it points at. */
export interface NotificationItem {
  id: string;
  readAt: Date | null;
  createdAt: Date;
  activity: {
    id: string;
    orgId: string | null;
    action: ActivityAction;
    entityType: string;
    entityId: string;
    summary: Record<string, unknown> | null;
    createdAt: Date;
    actor: { id: string; email: string; displayName: string; code: string | null } | null;
  };
}

/**
 * In-app notifications. Fan-out turns an `activity_log` row into one `notifications`
 * row per recipient; the inbox endpoints read / mark them for the calling user.
 */
@Injectable()
export class NotificationService {
  constructor(
    @InjectRepository(Notification) private notificationRepo: Repository<Notification>,
    @InjectRepository(ActivityLog) private activityRepo: Repository<ActivityLog>,
  ) {}

  // ----- Fan-out ------------------------------------------------------------

  /** Fan out the given (just-committed) activity rows. Rows already notified — or
   * that no longer exist — are skipped. Returns how many were fanned out. */
  async notifyActivities(ids: string[]): Promise<number> {
    if (ids.length === 0) return 0;
    const rows = await this.activityRepo.find({ where: { id: In(ids), notifiedAt: IsNull() } });
    return this.fanOut(rows);
  }

  /** Catch-up for rows the listener missed (restart, thrown error): anything still
   * un-notified past a short grace period, oldest first, in batches. */
  async sweepPending(): Promise<number> {
    const rows = await this.activityRepo.find({
      where: { notifiedAt: IsNull(), createdAt: LessThan(new Date(Date.now() - SWEEP_GRACE_MS)) },
      order: { createdAt: 'ASC' },
      take: SWEEP_BATCH,
    });
    return this.fanOut(rows);
  }

  private async fanOut(rows: ActivityLog[]): Promise<number> {
    let count = 0;
    for (const activity of rows) {
      if (await this.fanOutOne(activity)) count++;
    }
    return count;
  }

  /**
   * Deliver one activity, in a transaction that first **claims** it (stamping
   * `notified_at` only if still null) so the listener and the sweep never both do
   * the work; the unique `(recipient, activity)` index is the backstop.
   */
  private async fanOutOne(activity: ActivityLog): Promise<boolean> {
    return this.activityRepo.manager.transaction(async (em) => {
      const claimed = await em
        .createQueryBuilder()
        .update(ActivityLog)
        .set({ notifiedAt: () => 'now()' })
        .where('id = :id AND notified_at IS NULL', { id: activity.id })
        .execute();
      if (!claimed.affected) return false;

      const recipients = await this.resolveRecipients(em, activity);
      if (recipients.length > 0) {
        await em
          .createQueryBuilder()
          .insert()
          .into(Notification)
          .values(recipients.map((recipientId) => ({ recipientId, activityId: activity.id })))
          .orIgnore()
          .execute();
      }
      return true;
    });
  }

  /**
   * Who hears about an activity — never the actor themself:
   *   - the **subject** (the client whose order/shipment/balance it was, or the
   *     credit-group owner credited a commission), when someone else acted;
   *   - the staff roles in {@link STAFF_RECIPIENTS} for that action, in its org.
   */
  private async resolveRecipients(em: EntityManager, activity: ActivityLog): Promise<string[]> {
    const recipients = new Set<string>();
    if (activity.subjectUserId) recipients.add(activity.subjectUserId);

    const permissions = STAFF_RECIPIENTS[activity.action];
    if (permissions && activity.orgId) {
      const rows: Array<{ id: string }> = await em.query(
        `SELECT DISTINCT ug.user_id_fk AS id
           FROM wh.user_groups ug
           JOIN wh.org_groups g        ON g.id = ug.group_id_fk AND g.org_id_fk = $1
           JOIN wh.group_permissions gp ON gp.group_id_fk = g.id
           JOIN wh.permissions p       ON p.id = gp.permission_id_fk AND p.name = ANY($2)
           JOIN wh.users_orgs uo       ON uo.user_id_fk = ug.user_id_fk AND uo.org_id_fk = $1`,
        [activity.orgId, permissions],
      );
      for (const row of rows) recipients.add(row.id);
    }

    if (activity.actorId) recipients.delete(activity.actorId);
    return [...recipients];
  }

  // ----- Inbox --------------------------------------------------------------

  /** The caller's notifications, newest first, keyset-paginated by (created_at, id).
   * Optional `orgId` (the activity's org) and `unread` filters. */
  async listMine(
    userId: string,
    filters: NotificationFilters,
    limitRaw?: string,
    cursor?: string,
  ): Promise<Page<NotificationItem>> {
    const limit = parseLimit(limitRaw);
    const qb = this.notificationRepo
      .createQueryBuilder('n')
      .innerJoinAndSelect('n.activity', 'a')
      .leftJoin('a.actor', 'actor')
      .addSelect(['actor.id', 'actor.email', 'actor.displayName', 'actor.code'])
      .where('n.recipientId = :userId', { userId })
      .orderBy('n.createdAt', 'DESC')
      .addOrderBy('n.id', 'DESC')
      .take(limit + 1);

    if (filters.orgId) qb.andWhere('a.orgId = :orgId', { orgId: filters.orgId });
    if (filters.unread) qb.andWhere('n.readAt IS NULL');

    if (cursor) {
      const { t, id } = decodeCursor(cursor);
      qb.andWhere('(n.createdAt < :t OR (n.createdAt = :t AND n.id < :curId))', {
        t: new Date(t),
        curId: id,
      });
    }

    const page = toPage(await qb.getMany(), limit);
    return { items: page.items.map((n) => this.toItem(n)), nextCursor: page.nextCursor };
  }

  /** How many unread notifications the caller has (optionally within one org). */
  async unreadCount(userId: string, orgId?: string): Promise<{ count: number }> {
    const qb = this.notificationRepo
      .createQueryBuilder('n')
      .where('n.recipientId = :userId', { userId })
      .andWhere('n.readAt IS NULL');
    if (orgId) qb.innerJoin('n.activity', 'a').andWhere('a.orgId = :orgId', { orgId });
    return { count: await qb.getCount() };
  }

  /** Mark one of the caller's notifications read (idempotent). 404 if it isn't theirs. */
  async markRead(userId: string, notificationId: string): Promise<{ id: string; readAt: Date }> {
    const notification = await this.notificationRepo.findOne({
      where: { id: notificationId, recipientId: userId },
    });
    if (!notification) throw new NotFoundException('Notification not found');
    if (!notification.readAt) {
      notification.readAt = new Date();
      await this.notificationRepo.save(notification);
    }
    return { id: notification.id, readAt: notification.readAt };
  }

  /** Mark all of the caller's unread notifications read (optionally within one org). */
  async markAllRead(userId: string, orgId?: string): Promise<{ updated: number }> {
    const qb = this.notificationRepo
      .createQueryBuilder()
      .update(Notification)
      .set({ readAt: () => 'now()' })
      .where('recipient_id_fk = :userId AND read_at IS NULL', { userId });
    if (orgId) {
      qb.andWhere('activity_id_fk IN (SELECT id FROM wh.activity_log WHERE org_id_fk = :orgId)', {
        orgId,
      });
    }
    const result = await qb.execute();
    return { updated: result.affected ?? 0 };
  }

  private toItem(n: Notification): NotificationItem {
    const a = n.activity;
    return {
      id: n.id,
      readAt: n.readAt,
      createdAt: n.createdAt,
      activity: {
        id: a.id,
        orgId: a.orgId,
        action: a.action,
        entityType: a.entityType,
        entityId: a.entityId,
        summary: a.summary,
        createdAt: a.createdAt,
        actor: a.actor
          ? {
              id: a.actor.id,
              email: a.actor.email,
              displayName: a.actor.displayName,
              code: a.actor.code,
            }
          : null,
      },
    };
  }
}
