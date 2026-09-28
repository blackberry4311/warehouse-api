-- Read side of the activity feed (GET /activity?orgId=): a new group permission to
-- view every order / shipment change and balance movement in the org. Grant it to
-- the relevant groups after applying this.
INSERT INTO wh.permissions (name, description, is_group_permission, category)
VALUES ('view_activity_log', 'View the org activity log (orders, shipments, balances)', true,
        'organization')
ON CONFLICT (name) DO NOTHING;

-- Keyset scan for the ?subjectUserId= filter (a member's order/shipment/balance feed).
CREATE INDEX IF NOT EXISTS activity_log_subject_created_idx
    ON wh.activity_log (subject_user_id_fk, created_at DESC, id DESC);
