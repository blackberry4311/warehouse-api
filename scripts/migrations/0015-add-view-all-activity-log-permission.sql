-- Activity feed (GET /activity) scoping rework:
--   * the route is now authenticated-only — every user sees the rows they acted on or
--     are the subject of, so view_activity_log is no longer needed and is dropped
--     (its group_permissions grants cascade away with it);
--   * view_all_activity_log widens the feed to every row in each org where it is held.
-- Grant view_all_activity_log to the groups that should see the full org feed after
-- applying this.
INSERT INTO wh.permissions (name, description, is_group_permission, category)
VALUES ('view_all_activity_log', 'View the full org activity log (all users)', true,
        'organization')
ON CONFLICT (name) DO NOTHING;

DELETE FROM wh.permissions WHERE name = 'view_activity_log';
