-- Keyset index for the org-wide credit ledger reads (GET /organizations/:orgId/credit/
-- ledger, /summary, /daily). credit_history_org_created_idx was in an earlier
-- init.sql and dropped when it was regenerated; recreated under the same name.
CREATE INDEX IF NOT EXISTS credit_history_org_created_idx
    ON wh.credit_history (org_id_fk, created_at DESC, id DESC);
