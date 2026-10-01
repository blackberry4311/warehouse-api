-- Reports (GET /reports/*) are authenticated-only: every user gets a report over their
-- own orders / shipments / ledger in the orgs they belong to. view_all_report is a
-- global grant — held in any org, it opens the reports over every org and every user.
-- Grant it to the groups that should see the warehouse-wide reports after applying this.
INSERT INTO wh.permissions (name, description, is_group_permission, category)
VALUES ('view_all_report', 'View reports across all organizations and users', true,
        'organization')
ON CONFLICT (name) DO NOTHING;
