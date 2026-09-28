import { ActivityLog } from '../entities/activity-log.entity';

/**
 * Emitted (via `EventEmitter2`) once a transaction that wrote `activity_log` rows has
 * **committed** — never for a rolled-back action. Best-effort: a listener that misses
 * it (crash, thrown error) is covered by the notification sweep, since every emitted
 * row is also persisted with `notified_at = null`.
 */
export const ACTIVITY_RECORDED = 'activity.recorded';

export interface ActivityRecordedEvent {
  activities: ActivityLog[];
}
