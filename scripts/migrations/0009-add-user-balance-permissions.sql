-- Split member-balance access out of manage_org_members into two dedicated group
-- permissions:
--   view_user_balances   — list every member's balance in the org and read any
--                          member's ledger / summary / top-up bills.
--   manage_user_balances — everything view_user_balances allows, plus topping a
--                          member up and attaching/removing top-up bills.
-- Existing manage_org_members holders lose these abilities; grant the new
-- permissions to the relevant groups after applying this.
INSERT INTO wh.permissions (name, description, is_group_permission, category)
VALUES ('view_user_balances', 'View member wallet balances and credit history', true, 'organization'),
       ('manage_user_balances', 'Top up member wallets and manage top-up bills', true, 'organization')
ON CONFLICT (name) DO NOTHING;
