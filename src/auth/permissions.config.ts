/**
 * Authored source of truth for route authorization, keyed by **permission name**.
 *
 * Each entry maps a permission name (matched against `wh.permissions`) to the list
 * of routes it grants access to, expressed as `"<method> <route path>"` (lowercase
 * method, Nest/Fastify route pattern). One permission can gate many routes, and a
 * single route may be granted by more than one permission (the caller needs any
 * one of them) — e.g. the order read routes below are reachable by both the client
 * who placed orders (`place_order`) and operations staff (`manage_order`).
 *
 * Any route NOT listed here is public. Edit this map to change access — no
 * decorators or redeploy of route code needed.
 *
 * Note: this only gates *reachability* of a route. Row-level scoping (e.g. a
 * `place_order` client only sees their own orders, while `manage_order` staff see
 * every order in the org) is enforced in `OrderService`, not here.
 */
export const PERMISSION_API_MAP: Record<string, string[]> = {
  // Users
  add_user: ['post /organizations/users', 'patch /organizations/users/:userId'],

  // Organizations
  manage_organizations: ['post /organizations', 'delete /organizations/:orgId'],
  view_organizations: ['get /organizations', 'get /organizations/:orgId'],

  // Members
  manage_org_members: [
    'post /organizations/:orgId/members',
    'delete /organizations/:orgId/members/:userId',
  ],
  view_org_members: ['get /organizations/:orgId/members'],
  view_user_permissions: ['get /organizations/:orgId/members/:userId/permissions'],

  // Groups
  manage_groups: [
    'post /organizations/:orgId/groups',
    'delete /organizations/:orgId/groups/:groupId',
  ],
  view_groups: ['get /organizations/:orgId/groups'],

  // Group membership
  manage_group_members: [
    'get /organizations/:orgId/members/:userId/groups',
    'post /organizations/:orgId/groups/:groupId/members',
    'delete /organizations/:orgId/groups/:groupId/members/:userId',
  ],

  // Group permissions
  view_group_permissions: ['get /organizations/:orgId/groups/:groupId/permissions'],
  manage_group_permissions: [
    'post /organizations/:orgId/groups/:groupId/permissions',
    'delete /organizations/:orgId/groups/:groupId/permissions/:permissionId',
  ],

  // Permission catalog
  manage_permissions: ['post /organizations/permissions/catalog'],
  view_permissions: ['get /organizations/permissions/catalog'],

  // Orders (top-level resource; org carried in body/query, or derived from the order)
  //
  // A client with `place_order` can place orders and read *their own* orders and
  // history. Operations staff with `manage_order` process orders (status moves)
  // and can read *every* order in the org and its history. The read routes are
  // therefore granted by both; OrderService applies the own-vs-all scoping.
  place_order: [
    'post /orders',
    'patch /orders/:orderId',
    'get /orders',
    'get /orders/:orderId',
    'get /orders/:orderId/history',
  ],
  manage_order: [
    'patch /orders/:orderId/status',
    'get /orders',
    'get /orders/:orderId',
    'get /orders/:orderId/history',
  ],
};

/**
 * Reverse index derived from `PERMISSION_API_MAP` for O(1) lookup by the global
 * `PermissionsGuard`: `"<method> <route path>"` -> the permission names that grant
 * it. A route reachable by several permissions lists all of them; the caller needs
 * to hold any one.
 *
 * Do not edit directly — edit `PERMISSION_API_MAP` above.
 */
export const API_PERMISSION_MAP: Record<string, string[]> = Object.entries(
  PERMISSION_API_MAP,
).reduce<Record<string, string[]>>((acc, [permission, routes]) => {
  for (const route of routes) {
    (acc[route] ??= []).push(permission);
  }
  return acc;
}, {});
