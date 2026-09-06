/**
 * Live permission map read by the global `PermissionsGuard` at request time.
 *
 * Key   = `"<method> <route path>"` (lowercase method, Nest/Fastify route pattern).
 * Value = the permission name required to call it (matched against `wh.permissions`).
 *
 * Any route NOT listed here is public. Edit this map to change access — no
 * decorators or redeploy of route code needed.
 */
export const API_PERMISSION_MAP: Record<string, string> = {
  // Users
  'post /organizations/users': 'add_user',

  // Organizations
  'post /organizations': 'manage_organizations',
  'get /organizations': 'view_organizations',
  'get /organizations/:orgId': 'view_organizations',

  // Members
  'post /organizations/:orgId/members': 'manage_org_members',
  'get /organizations/:orgId/members': 'view_org_members',
  'delete /organizations/:orgId/members/:userId': 'manage_org_members',
  'get /organizations/:orgId/members/:userId/permissions': 'view_user_permissions',

  // Groups
  'post /organizations/:orgId/groups': 'manage_groups',
  'get /organizations/:orgId/groups': 'view_groups',
  'delete /organizations/:orgId/groups/:groupId': 'manage_groups',

  // Group membership
  'post /organizations/:orgId/groups/:groupId/members': 'manage_group_members',
  'delete /organizations/:orgId/groups/:groupId/members/:userId': 'manage_group_members',

  // Group permissions
  'get /organizations/:orgId/groups/:groupId/permissions': 'view_group_permissions',
  'post /organizations/:orgId/groups/:groupId/permissions': 'manage_group_permissions',
  'delete /organizations/:orgId/groups/:groupId/permissions/:permissionId':
    'manage_group_permissions',

  // Permission catalog
  'post /organizations/permissions/catalog': 'manage_permissions',
  'get /organizations/permissions/catalog': 'view_permissions',
};
