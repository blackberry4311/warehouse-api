-- System-wide activity feed: one append-only row per user action (orders, shipments,
-- credit top-ups/adjustments), written in the same transaction as the change. Sits
-- alongside order_history / shipment_history / credit_history, which keep the
-- detailed per-entity trail. `action` is deliberately not CHECK-constrained so new
-- actions don't need a migration; `entity_type` is.
CREATE TABLE IF NOT EXISTS wh.activity_log
(
    id                 uuid        DEFAULT gen_random_uuid() NOT NULL PRIMARY KEY,
    org_id_fk          uuid
        REFERENCES wh.organizations
            ON UPDATE CASCADE ON DELETE CASCADE,
    actor_id_fk        uuid
        REFERENCES wh.users
            ON UPDATE CASCADE ON DELETE SET NULL,
    subject_user_id_fk uuid
        REFERENCES wh.users
            ON UPDATE CASCADE ON DELETE SET NULL,
    entity_type        varchar(30) NOT NULL
        CONSTRAINT activity_log_entity_type_check
            CHECK (entity_type IN ('ORDER', 'SHIPMENT', 'CREDIT')),
    entity_id          uuid        NOT NULL,
    action             varchar(50) NOT NULL,
    summary            jsonb,
    created_at         timestamp(3) with time zone DEFAULT now() NOT NULL
);

-- Keyset scans for the org-wide feed and the per-actor filter.
CREATE INDEX IF NOT EXISTS activity_log_org_created_idx
    ON wh.activity_log (org_id_fk, created_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS activity_log_actor_created_idx
    ON wh.activity_log (actor_id_fk, created_at DESC, id DESC);
