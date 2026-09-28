-- Keyset indexes for the credit ledger reads (GET /users/me/credit, GET
-- /organizations/:orgId/members/:userId/credit) and their /summary aggregates.
-- credit_history_user_created_idx was in an earlier init.sql and dropped when it was
-- regenerated; recreated here under the same name so an existing copy is kept.
CREATE INDEX IF NOT EXISTS credit_history_user_created_idx
    ON wh.credit_history (user_id_fk, created_at DESC, id DESC);

CREATE INDEX IF NOT EXISTS credit_history_user_org_created_idx
    ON wh.credit_history (user_id_fk, org_id_fk, created_at DESC, id DESC);
