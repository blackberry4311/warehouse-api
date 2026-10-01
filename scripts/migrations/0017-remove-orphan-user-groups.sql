-- Removing a member used to delete only their users_orgs row, leaving their
-- user_groups rows in that org's groups behind — so a user who left an org (or
-- belongs to none) kept that org's group permissions. removeMember now drops them
-- together; this cleans up the assignments already orphaned.
DELETE FROM wh.user_groups ug
USING wh.org_groups g
WHERE g.id = ug.group_id_fk
  AND NOT EXISTS (SELECT 1
                  FROM wh.users_orgs uo
                  WHERE uo.user_id_fk = ug.user_id_fk
                    AND uo.org_id_fk = g.org_id_fk);
