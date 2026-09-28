import { EntityManager } from 'typeorm';
import {
  ActivityAction,
  ActivityEntityType,
  ActivityLog,
  ActivitySummary,
} from '../entities/activity-log.entity';

export interface ActivityInput {
  orgId: string | null;
  actorId: string | null;
  subjectUserId?: string | null;
  entityType: ActivityEntityType;
  entityId: string;
  action: ActivityAction;
  summary?: ActivitySummary | null;
}

/**
 * Append an `activity_log` row on the caller's transaction manager, so the activity
 * commits (or rolls back) together with the change it describes. Call it next to the
 * per-entity history write in every mutation that should show up in the feed.
 */
export async function recordActivity(em: EntityManager, input: ActivityInput): Promise<void> {
  await em.save(
    em.create(ActivityLog, {
      orgId: input.orgId,
      actorId: input.actorId,
      subjectUserId: input.subjectUserId ?? null,
      entityType: input.entityType,
      entityId: input.entityId,
      action: input.action,
      summary: input.summary ?? null,
    }),
  );
}
