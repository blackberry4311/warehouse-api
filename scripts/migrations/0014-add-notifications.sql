-- In-app notifications, fanned out from wh.activity_log. After an action commits, the
-- app emits `activity.recorded`; a listener resolves the recipients and writes one
-- notifications row each, then stamps activity_log.notified_at. A cron sweep re-runs
-- the fan-out for any row still unstamped (e.g. the process restarted mid-way).

-- 1. The fan-out marker. Everything already in the log (incl. the 0013 backfill) is
--    history, not news: mark it notified so the sweep never notifies it.
ALTER TABLE wh.activity_log
    ADD COLUMN IF NOT EXISTS notified_at timestamp(3) with time zone;

UPDATE wh.activity_log
SET notified_at = created_at
WHERE notified_at IS NULL;

-- Small partial index: the sweep only ever scans the not-yet-notified tail.
CREATE INDEX IF NOT EXISTS activity_log_pending_notify_idx
    ON wh.activity_log (created_at)
    WHERE notified_at IS NULL;

-- 2. One row per (recipient, activity). The unique pair makes the fan-out idempotent,
--    so the listener and the sweep can both run without duplicating.
CREATE TABLE IF NOT EXISTS wh.notifications
(
    id              uuid DEFAULT gen_random_uuid() NOT NULL PRIMARY KEY,
    recipient_id_fk uuid                           NOT NULL
        REFERENCES wh.users
            ON UPDATE CASCADE ON DELETE CASCADE,
    activity_id_fk  uuid                           NOT NULL
        REFERENCES wh.activity_log
            ON UPDATE CASCADE ON DELETE CASCADE,
    read_at         timestamp(3) with time zone,
    created_at      timestamp(3) with time zone DEFAULT now() NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS notifications_recipient_activity_unique
    ON wh.notifications (recipient_id_fk, activity_id_fk);
-- The user's inbox (keyset, newest first) and their unread count.
CREATE INDEX IF NOT EXISTS notifications_recipient_created_idx
    ON wh.notifications (recipient_id_fk, created_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS notifications_recipient_unread_idx
    ON wh.notifications (recipient_id_fk)
    WHERE read_at IS NULL;
CREATE INDEX IF NOT EXISTS notifications_activity_idx
    ON wh.notifications (activity_id_fk);
