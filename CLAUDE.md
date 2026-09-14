# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

`warehouse-api`: a NestJS 11 (Fastify) backend. It implements JWT-based authentication
(register / login / refresh / logout), a **multi-tenant RBAC layer** (organizations, membership,
groups/roles, and permissions), an **order system** (org-scoped orders with a status lifecycle
and an audit trail), a **shipment system** (org-scoped outbound shipments that draw quantity from
one or more warehoused orders, mirroring the order flow — status lifecycle, review-lock gate, and
audit trail), a **credit / billing layer** (a per-user credit wallet charged a per-org fee when an
order or a shipment is locked, with a full ledger), and a small **self-service layer** (the
authenticated user reads/updates their own profile and reviews their own wallet), all over a
Postgres database in the `wh` schema.

`@anthropic-ai/sdk` is listed as a dependency but is not yet used anywhere in `src/`.

## Commands

```bash
yarn start:dev        # nest start --watch (primary dev loop)
yarn start:debug      # watch mode + --debug (inspector)
yarn build            # nest build
yarn start:prod       # run compiled dist/main.js

yarn lint             # eslint --fix over src/apps/libs/test
yarn format           # prettier --write over src + test

yarn test             # jest unit tests (*.spec.ts, rootDir: src)
yarn test:watch
yarn test:cov
yarn test:e2e         # separate config at test/jest-e2e.json
```

Run a single unit test file:
```bash
yarn jest path/to/file.spec.ts
```

There are currently **no `*.spec.ts` files** in `src/` — adding tests for a module means creating the
first spec for it.

## Environment / running locally

Requires Postgres with a `wh` schema — see `scripts/init.sql` for the full DDL. Run it manually
against a fresh DB: there is no migration runner wired up, and `synchronize: false` in
`TypeOrmModule.forRootAsync` (`app.module.ts`) means TypeORM will never auto-create or alter tables.
`scripts/init.sql` is the full-schema bootstrap for a **fresh** DB. It is **not** kept in lockstep
with each change — it may lag behind the latest migrations and is reconciled back to current state by
hand when needed.

**Every change to the schema or to seed/reference data MUST ship a migration script** — no schema or
data change is complete without one, and the migration (not `init.sql`) is what you write for the
change. This covers any change to a table, column, index, constraint, enum/`CHECK`, or to seeded rows
(e.g. `wh.permissions`, `wh.org_fees`), whether it originates from an entity change in `src/entities/`
or from a hand-written SQL tweak. For each such change:
1. Add a new migration file under `scripts/migrations/`, named `NNNN-short-description.sql` with a
   zero-padded sequence number one higher than the last (e.g. `0001-add-orders-shipped-qty.sql`), so
   files apply in filename order. Each migration is **forward-only** and **idempotent** where
   practical (`IF NOT EXISTS` / `IF EXISTS`, guarded inserts), holding only the incremental DDL/DML
   for that one change against the `wh` schema.
2. Apply the migration by hand to any already-running database (there is no runner).

Do **not** edit `scripts/init.sql` as part of the change — leave it as-is; it gets reconciled to the
accumulated migrations separately, later. So a schema/data change touches two things: the entity/code
and a new `scripts/migrations/NNNN-*.sql`.

Required env vars (see `.env.sample`):
- `DATABASE_URL` — Postgres connection string. Note: the sample value still points at a DB named
  `innerworld` (a leftover); change it to your local warehouse DB.
- `JWT_ACCESS_SECRET` / `JWT_ACCESS_EXPIRY`, `JWT_REFRESH_SECRET` / `JWT_REFRESH_EXPIRY`
- `ANTHROPIC_API_KEY` — present in `.env.sample` but not read anywhere in `src/` yet.

The server listens on `PORT` (default **3003**), bound to `0.0.0.0`. `main.ts` enables CORS for
`http://localhost:3000` (credentials on) and installs a global `ValidationPipe` with
`whitelist: true` + `forbidNonWhitelisted: true` — request bodies are validated against DTO
class-validator decorators and unknown properties are rejected.

## Architecture

### Module layout
- `AppModule` wires global `ConfigModule`, a single async `TypeOrmModule.forRootAsync` (Postgres,
  schema `wh`, `synchronize: false`) registering every entity in `src/entities/`, a
  `TypeOrmModule.forFeature([User, RefreshToken])`, and the feature modules `AuthModule`,
  `OrganizationModule`, `RbacModule`, `OrderModule`, `ShipmentModule`, and `UserModule`.
- `AuthModule` — registration/login/refresh/logout. Uses `@nestjs/jwt`, `bcrypt` for password
  hashing, and two Passport JWT strategies:
  - `jwt-access` (Bearer header) — guards ordinary endpoints via `JwtAccessGuard`.
  - `jwt-refresh` (reads `refreshToken` from the request **body**) — guards only `POST /auth/refresh`.
  Refresh tokens are stored server-side as hashes (`RefreshToken` entity) with rotation on refresh
  (old token revoked, new row issued). `user_agent` / `ip_address` are captured per token.
- `OrganizationModule` (`src/organization/`) — manages everything under an organization: the org
  itself, membership (users_orgs), groups/roles (org_groups), the global permission catalog
  (permissions), the group↔permission and user↔group wiring, and the **credit / billing layer**
  (per-org fees, member credit top-ups, and the credit-review endpoint). It exports
  `OrganizationService` for reuse (by `RbacModule` for permission resolution, and by the order /
  shipment / self-service modules); it does **not** own the global guard.
- `RbacModule` (`src/rbac/`) — the authorization layer: registers the map-driven global
  `PermissionsGuard` (via `APP_GUARD`, so it runs on every route) and owns the authored
  `PERMISSION_API_MAP` source of truth (`src/rbac/permissions.config.ts`). Imports `OrganizationModule`
  for `OrganizationService` (permission resolution), plus `JwtModule` and the `User` repo the guard
  needs. Nothing imports `RbacModule` back, so the graph stays acyclic (Rbac → Organization → Auth);
  `AuthModule` stays a lean authN-only module and does **not** know a guard exists.
- `OrderModule` (`src/order/`) — the order system: place orders, drive their status lifecycle, and
  read orders + history. Standalone module (not part of `OrganizationModule`); it imports
  `OrganizationModule` only to reuse `OrganizationService` (org existence, `assertOrgMembership`,
  `resolveUserCode`, `hasOrgPermission`). All order logic lives in `OrderService` — including the
  credit charge on lock, which reads `org_fees` and writes `credit_history` directly in its
  transaction. Both `OrderService` and `OrganizationService` (for the credit ledger) share the keyset
  pagination helper in `src/common/pagination.util.ts`.
- `ShipmentModule` (`src/shipment/`) — the shipment system: request shipments (each drawing quantity
  from one or more warehoused orders), review/lock them, drive their status, and read shipments +
  history. Structurally the mirror of `OrderModule` — standalone, imports `OrganizationModule` only to
  reuse `OrganizationService`. All logic lives in `ShipmentService`, including the `SHIPMENT_LOCK`
  credit charge **and** the stock deduction on lock (it adds each line's qty to the order's
  `shipped_qty` and writes `order_history` for any order it completes, all in the lock transaction).
  Shares the keyset pagination helper.
- `UserModule` (`src/user/`) — self-service for the authenticated user (read/update their own profile
  and review their own wallet, `/users/me*`), **plus** one administrator route: the global user
  directory `GET /users`. Standalone module (its own `UserService` over
  `forFeature([User, CreditHistory, UserOrg])` — `UserOrg` is read to attach each listed user's org
  memberships); it does **not** depend on `OrganizationModule`. The `/me*` routes are authenticated-only
  (`@UseGuards(JwtAccessGuard)` on the controller, left out of `PERMISSION_API_MAP`) and scoped to the
  caller's own id; `GET /users` is the exception — it is listed in `PERMISSION_API_MAP` under
  `manage_all_users`, so the global `PermissionsGuard` gates it (admins bypass) before the
  controller-level `JwtAccessGuard` runs. Reuses the shared keyset pagination helper for both the credit
  ledger and the directory.

### Organization / RBAC endpoints (`OrganizationController`, prefix `organizations`)
- Me: `GET /organizations/me` — the caller's access tree
  (`{ userId, isAdmin, organizations: [{ id, name, groups: [{ id, name, permissions }] }], permissions }`),
  for the FE to render UI after login. For an `is_admin` user, `permissions` is the **full catalog**
  (they bypass all checks); everyone else gets their group-derived set. Authenticated-only (see
  below). Declared before `:orgId`.
- Orgs: `POST /organizations`, `GET /organizations`, `GET /organizations/:orgId`.
- Users: `POST /organizations/users` (requires `add_user`; auto-attaches to the caller's org).
- Members: `POST|GET /organizations/:orgId/members`, `DELETE /organizations/:orgId/members/:userId`,
  `GET /organizations/:orgId/members/:userId/permissions` (resolves effective permissions).
- Member credit: `POST /organizations/:orgId/members/:userId/credit` (requires `manage_org_members`)
  tops a member up (writes a `TOP_UP` ledger row); `GET /organizations/:orgId/members/:userId/credit`
  returns `{ userId, orgId, credit, history }` — the member's wallet balance plus their org-scoped
  ledger, cursor-paginated. See **Credit / billing** below.
- Fees (system-admin only): `POST|GET /organizations/:orgId/fees` — set / list an org's flat fees.
- Groups: `POST|GET /organizations/:orgId/groups`, `DELETE /organizations/:orgId/groups/:groupId`.
- Group membership: `POST /organizations/:orgId/groups/:groupId/members`,
  `DELETE /organizations/:orgId/groups/:groupId/members/:userId`.
- Group permissions: `GET|POST /organizations/:orgId/groups/:groupId/permissions`,
  `DELETE /organizations/:orgId/groups/:groupId/permissions/:permissionId`.
- Permission catalog: `POST|GET /organizations/permissions/catalog`.

`OrganizationService.getUserPermissions(orgId, userId)` resolves a user's effective permissions by
walking user → user_groups → group_permissions → permissions, scoped to groups belonging to the org.

### Order system (`OrderController`, prefix `orders`)
Orders are a **top-level resource** anchored by their own `orderId`, kept deliberately separate from
the `organizations` (org-management) routes. They're still **org-scoped**: a client places an order
into an org, and that org's operations staff drive its status. The org is carried in the body on
create and as a `?orgId=` query filter on list; single-order routes **derive the org from the order
itself**. Every endpoint checks the caller **belongs to that org** (via
`OrganizationService.assertOrgMembership`, admins excepted), so a permission held in one org can't be
used to act on another — mirroring `POST /organizations/users`.

**Three order roles + the review/lock gate + row-level scoping.** Access to an order is driven by
three permissions, split around a **lock** — a reviewer's one-way gate that hands an order off from
the client to operations (`orders.locked`; when and by whom it was locked are recorded on the `LOCKED`
`order_history` row's `created_at` / `changed_by_fk`, not on the order; orthogonal to `status`):
- `place_order` — a **client**: places orders, and while the order is still **unlocked** edits its qty
  and drives its two client-reported pending states (`SHIPPING ↔ ARRIVING`) or cancels it; reads
  **only the orders they placed** (and those orders' history).
- `review_order` — a **reviewer**: reviews and **locks** a pending (`SHIPPING`/`ARRIVING`) order via
  `POST /orders/:orderId/lock`, edits a **locked** order's qty (but **not** its status), and reads
  **every order in the org**. Locking freezes the client out and surfaces the order into the operations
  queue. Only `review_order` can lock.
- `manage_order` — **operations staff**: drives a **locked** order's status along the warehouse
  lifecycle, and reads **every *locked* order in the org** and its history.

The three read routes (`GET /orders`, `GET /orders/:orderId`, `GET /orders/:orderId/history`) are
reachable by **any** of these permissions — `PermissionsGuard` allows a route if the caller holds
*any* of its mapped permissions — and `OrderService` then applies the row-level scoping (via
`resolveAccess`, which checks all three with `OrganizationService.hasOrgPermission`, true for admins):
a reviewer (and admins) sees every order in the org, operations sees only `locked = true` orders, a
client sees only `order.userId = :userId`. A caller holding several permissions sees the **union**.
`getOrder` (also the gate for history and status updates) throws `404` when a caller touches an order
outside their scope, so they can't probe which orders exist. `listOrders` also accepts an optional
`?locked=true|false` filter (useful for a reviewer splitting their review queue from the processed set).

- `POST /orders` (`place_order`) — client places an order. Body `PlaceOrderDto` (`orgId`, `qty`,
  **required** `tracking` — a free-text carrier reference/URL, since goods always ship via an external
  system, optional `note`). Created as `SHIPPING`, unlocked.
- `GET /orders?orgId=:orgId` (`place_order` | `review_order` | `manage_order`) — list an org's orders
  (`orgId` required query param), newest first; scoped per the roles above. Optional `?status=`,
  `?search=`, `?locked=` filters. Cursor-paginated (see below).
- `GET /orders/:orderId` (`place_order` | `review_order` | `manage_order`) — one order; org derived
  from the order. Scoped per the roles above.
- `PATCH /orders/:orderId` — edit `qty`. Body `UpdateOrderDto` (`qty`, optional `note`); writes a
  `QTY_CHANGE` row. Shared route, actor resolved by the lock gate: while **unlocked** only the owner
  (`place_order`) may edit, and only while `SHIPPING`/`ARRIVING`; while **locked** only a reviewer
  (`review_order`) may edit, up until a terminal state.
- `PATCH /orders/:orderId/status` — move the order's status. Body `UpdateOrderStatusDto` (`status`,
  optional `note`); writes a `STATUS_CHANGE` row. Shared route, actor resolved by the lock gate: while
  **unlocked** only the owner (`place_order`) may move it (`SHIPPING ↔ ARRIVING`, or cancel); while
  **locked** only operations (`manage_order`) may move it (warehouse lifecycle).
- `POST /orders/:orderId/lock` (`review_order`) — reviewer reviews and locks a `SHIPPING`/`ARRIVING`
  order. Body `LockOrderDto` (optional `note`). Writes a `LOCKED` history row. 400 if already locked or
  past the pending states. **Locking is the billing event**: the order's *client* (`order.userId`, not
  the acting reviewer) is charged the org's `ORDER_LOCK` fee, and a 400 is returned if their credit
  can't cover it. See **Credit / billing** below.
- `GET /orders/:orderId/history` (`place_order` | `review_order` | `manage_order`) — the order's audit trail, oldest
  first; same own-vs-all scoping as `GET /orders/:orderId`. Cursor-paginated (see below). Each row
  includes `changedByUser` (`{ id, displayName, email, code }`, joined on `changed_by_fk` — never
  `password_hash`) alongside the raw `changedBy` uuid, so the FE can render who made each change.

**Pagination** (`src/common/pagination.util.ts`, shared with the credit ledger) — the two list
endpoints use **keyset (cursor) pagination**, not offset, so it stays cheap on large tables. Query
params `limit` (default 20, max 100)
and `cursor`; the response is `{ items, nextCursor }` where `nextCursor` is `null` on the last page —
pass it back as `?cursor=` for the next page. The cursor is an opaque base64url of the last row's
`{ created_at, id }`; the query orders by and seeks on `(created_at, id)` (DESC for orders, ASC for
history), backed by the composite indexes `orders_org_created_idx` / `order_history_order_created_idx`.
Both `created_at` columns are `timestamp(3)` so the JS `Date` in the cursor round-trips exactly — full
microsecond precision would make the cursor skip rows.

**Status lifecycle** (`OrderStatus` enum + a DB `CHECK`): `SHIPPING → ARRIVING → IN_WAREHOUSE →
COMPLETED`, with `CANCELLED` reachable from any live (non-terminal) state;
`COMPLETED`/`CANCELLED` are terminal. Once an order reaches `IN_WAREHOUSE` the client can request a
shipment against it (see the **Shipment system** below); an order is also driven to `COMPLETED`
automatically — not by `updateStatus` — when shipments have shipped out all of its `qty`. The allowed
moves are **split by the lock gate** into two tables in `OrderService`:
- `CLIENT_TRANSITIONS` — what the owning client may do while **unlocked**: `SHIPPING ↔ ARRIVING`
  (report their shipment) and cancel. These are the two client-reported pending states.
- `MANAGE_TRANSITIONS` — what operations may do once **locked**: push from either pending state into
  `IN_WAREHOUSE`, then on to `COMPLETED`, and cancel.

`updateStatus` picks the table by `order.locked` and checks the actor (owner pre-lock, `manage_order`
post-lock), so the client can never touch a locked order and operations can never touch an unlocked
one. Locking is thus the handoff: a reviewer locks a `SHIPPING`/`ARRIVING` order, after which the
warehouse lifecycle begins.

**Order numbers** are human-readable and generated per placement as `<user code>-<6-digit seq>`
(e.g. `ACME-000123`):
- `users.code` is a per-user client code, assigned at user creation (optional `code` in
  `CreateUserDto`, else derived from display name/email via `OrganizationService.resolveUserCode`).
  Self-registered users without one get a code lazily on their first order.
- `wh.order_sequences` is a per-`(user, org)` counter bumped atomically inside the place-order
  transaction (`INSERT ... ON CONFLICT (user_id_fk, org_id_fk) DO UPDATE SET next_seq = next_seq + 1
  RETURNING next_seq`). Because the sequence restarts per org, `order_number` is unique **per org**
  (`unique (org_id_fk, order_number)`), not globally.
- `placeOrder`, `updateOrder`, `lockOrder` and `updateStatus` each run in a single transaction that
  writes the order **and** an `order_history` row (`CREATED` on placement, `QTY_CHANGE` on a client
  edit, `LOCKED` on review, `STATUS_CHANGE` on status moves), so an order always has a matching audit
  entry.

**Adding order permissions to a group:** the three permissions (`place_order`, `review_order`,
`manage_order`) are seeded in `scripts/init.sql`; grant them to groups via the existing
group-permission endpoints — `place_order` to a client group (place/edit + read own orders),
`review_order` to a Review group (review/lock + read all orders), `manage_order` to an Operations group
(process + read all locked orders in the org).

### Shipment system (`ShipmentController`, prefix `shipments`)
A **shipment** is a client's request to withdraw goods back out of the warehouse: it draws quantity
from one or more of the client's own warehoused orders. The module is the **mirror of the order
system** — same top-level org-scoped resource shape, same three-role + review/lock gate, same
row-level scoping, same cursor pagination and audit trail — so most of the order-system notes above
apply verbatim, with these shipment-specific points:

**Shipment ↔ order is many-to-many.** One shipment can ship (say) 10 units from order A and 20 from
order B. The per-order quantities live on the `shipment_details` junction (`Shipment.items`), keyed
`(shipment_id_fk, order_id_fk)` with a `qty` column. A shipment only references orders the placing
client owns, in the shipment's org, that are `IN_WAREHOUSE` with enough **remaining** qty
(`orders.qty - orders.shipped_qty`).

**Three roles + the review/lock gate** (identical structure to orders, resolved by
`ShipmentService.resolveAccess` via `OrganizationService.hasOrgPermission`):
- `place_shipment` — a **client**: requests shipments against their own orders, and while **unlocked**
  edits the line set / tracking (`PATCH /shipments/:shipmentId`) or cancels; reads **only their own**
  shipments and history.
- `review_shipment` — a **reviewer**: reviews and **locks** a `REQUESTED` shipment
  (`POST /shipments/:shipmentId/lock`); reads **every** shipment in the org. Only `review_shipment` can
  lock. (There is no reviewer edit-after-lock, unlike orders — a locked shipment's lines are fixed.)
- `manage_shipment` — **operations**: drives a **locked** shipment to `DELIVERED`/`CANCELLED`
  (`PATCH /shipments/:shipmentId/status`), and reads **every *locked*** shipment and its history.

The read routes (`GET /shipments`, `GET /shipments/:shipmentId`, `GET /shipments/:shipmentId/history`)
are reachable by any of the three; `ShipmentService` applies the same own/all/locked-only scoping and
`404`-on-out-of-scope as orders. `GET /shipments` takes a required `?orgId=`, optional `?status=`,
`?search=` (shipment number), `?locked=`, and keyset `limit`/`cursor`. `GET /shipments/:shipmentId`
returns the shipment with its `items` (each carrying the referenced order's number/qty/status).

**Status lifecycle** (`ShipmentStatus` enum + DB `CHECK`): `REQUESTED → DELIVERED`, with `CANCELLED`
reachable from `REQUESTED`; `DELIVERED`/`CANCELLED` are terminal. Split by the lock gate in
`ShipmentService` (`CLIENT_SHIPMENT_TRANSITIONS` / `MANAGE_SHIPMENT_TRANSITIONS`): while **unlocked**
only the owning client may act (cancel a `REQUESTED` shipment); once **locked** only operations may act
(`DELIVERED` or `CANCELLED`). Locking does **not** change `status` (it stays `REQUESTED`), exactly like
orders.

**Lock is the billing + stock-deduction event** (`ShipmentService.lockShipment`, one transaction):
- the shipment's **client** (`shipment.userId`) is charged the org's flat `SHIPMENT_LOCK` fee — same
  `FOR UPDATE`/insufficient-credit/`fee 0 = no charge` mechanics as the order-lock charge, writing a
  `SHIPMENT_LOCK` `credit_history` row linked via the new `credit_history.shipment_id_fk`;
- each line's `qty` is added to its order's `shipped_qty` (each order row locked `FOR UPDATE` and
  re-checked so concurrent locks can't over-ship), and any order whose `shipped_qty` reaches its `qty`
  is moved to `COMPLETED` with an `order_history` `STATUS_CHANGE` row written by the acting reviewer;
- a `LOCKED` `shipment_history` row is written.

Cancelling a **locked** shipment (operations) **reverses the deduction**: it subtracts each line's qty
back from the order's `shipped_qty` and reverts any order it had completed back to `IN_WAREHOUSE` (with
an `order_history` row). The fee is **not** refunded (mirrors orders). Cancelling an unlocked shipment
moves nothing (nothing was deducted).

**Shipment numbers**: `<user code>-S<6-digit seq>` (e.g. `ACME-S000123`), from a per-`(user, org)`
`wh.shipment_sequences` counter bumped the same way as `order_sequences`; unique per org. **History**:
`shipment_history` mirrors `order_history` (`CREATED` on placement, `ITEM_CHANGE` on a client edit,
`LOCKED` on review, `STATUS_CHANGE` on status moves), with `prev_qty`/`new_qty` holding the shipment's
**total** qty (summed across lines, since the per-line breakdown is on `shipment_details`), and
`changedByUser` joined the same way.

**Adding shipment permissions to a group:** the three permissions (`place_shipment`, `review_shipment`,
`manage_shipment`) are seeded in `scripts/init.sql` and mapped in `PERMISSION_API_MAP`; grant them to
groups exactly as the order permissions.

### Credit / billing
A per-user **credit wallet** (`users.credit`) is charged when an order **or a shipment** is locked, with
every movement recorded in an append-only ledger (`credit_history`). The credit logic is split across
`OrderService` and `ShipmentService` (the charges) and `OrganizationService` (fees, top-ups, the read
endpoint); there is no separate module.

- **The wallet.** `users.credit` is a single `numeric` balance per user, shared across all orgs (not
  per-org). Exposed as a JS number via `numericTransformer`. New users start at 0.
- **Per-org fees.** `wh.org_fees` holds a flat `amount` per `(org_id_fk, fee_type)`; `fee_type` is
  `ORDER_LOCK` (charged on order lock) or `SHIPMENT_LOCK` (charged on shipment lock). An org with
  **no row** for a fee_type is treated as fee **0** (not charged). Fees are billing config: set/listed
  only by a **system admin** (`is_admin`) via `POST|GET /organizations/:orgId/fees` (`SetOrgFeeDto`:
  `feeType`, `amount ≥ 0`). These routes are **not** in `PERMISSION_API_MAP` — they use
  `@UseGuards(JwtAccessGuard)` and `OrganizationService.setOrgFee`/`listOrgFees` enforce `is_admin`.
- **The charge (order lock).** `OrderService.lockOrder` resolves the org's `ORDER_LOCK` fee and, in the
  **same transaction** as the lock + `LOCKED` history row, charges the order's **client**
  (`order.userId`, not the acting reviewer): it `SELECT … FOR UPDATE`s the client's row (so concurrent
  charges/top-ups can't overdraw), throws `400` if `credit < fee`, deducts, and writes an `ORDER_LOCK`
  ledger row. A fee of 0 charges nothing and writes no ledger row.
- **The charge (shipment lock).** `ShipmentService.lockShipment` charges the shipment's **client** the
  org's `SHIPMENT_LOCK` fee identically, writing a `SHIPMENT_LOCK` ledger row linked via
  `credit_history.shipment_id_fk` (rather than `order_id_fk`). See the **Shipment system** above.
- **Top-ups.** `POST /organizations/:orgId/members/:userId/credit` (`TopUpCreditDto`: `amount > 0`,
  optional `note`) adds funds and writes a `TOP_UP` ledger row, in a `FOR UPDATE` transaction. Gated by
  **`manage_org_members`** (whoever manages members manages their top-ups); the acting user must belong
  to the org (admins excepted) and the target must be a member of it.
- **Reviewing credit.** `GET /organizations/:orgId/members/:userId/credit` returns
  `{ userId, orgId, credit, history }` — the member's **global** wallet balance plus the ledger entries
  **scoped to this org**, newest first, cursor-paginated (same `limit`/`cursor` keyset scheme as the
  order lists). Authenticated-only (`JwtAccessGuard`); `OrganizationService.getMemberCredit` authorizes
  the caller as **self, a system admin, or a `manage_org_members` holder** in the org. Each ledger row
  carries its own `prevBalance`/`newBalance` snapshot, so an org-filtered row stays self-consistent
  even though the wallet itself spans orgs.
- **The ledger** (`credit_history`). One row per change: `entry_type`
  (`ORDER_LOCK` | `SHIPMENT_LOCK` | `TOP_UP` | `ADJUSTMENT`), a **signed** `amount` (negative = a
  charge, positive = top-up/refund) so `new_balance = prev_balance + amount` always holds, a nullable
  `order_id_fk` (set on an `ORDER_LOCK` charge) **and** a nullable `shipment_id_fk` (set on a
  `SHIPMENT_LOCK` charge) linking a charge to what triggered it, and the `org_id_fk` the movement
  happened in.
- **Warehouse earnings** over a period for an org = `-SUM(amount)` over the charge entry types
  (`ORDER_LOCK`, `SHIPMENT_LOCK`) in `credit_history` — top-ups (positive) are excluded.

### User endpoints (`UserController`, prefix `users`)
Mostly self-service for the **authenticated caller**, scoped to `/me` — every `/me` action targets the
id resolved from the access token, so there is no target-user param and no permission/cross-user
check. The `/me` routes are **authenticated-only**: `@UseGuards(JwtAccessGuard)` on the controller, and
deliberately **not** in `PERMISSION_API_MAP` (the global `PermissionsGuard` treats unlisted routes as
public and passes through; `JwtAccessGuard` then enforces auth and sets `req.user`). Contrast with the
admin-facing `PATCH /organizations/users/:userId` (gated by `add_user`) and the manager's org-scoped
`GET /organizations/:orgId/members/:userId/credit`.
- `GET /users` — **administrator** route (the one non-`/me` route here): the global user directory for
  finding an existing account to (re-)assign to an org — e.g. re-adding a user removed from one, for
  which there is otherwise no lookup once they drop off an org's member list. Gated by the
  `manage_all_users` permission (in `PERMISSION_API_MAP`; admins bypass), so the global guard authorizes
  it before the controller's `JwtAccessGuard` re-checks auth. Excludes system admins; safe columns only
  (never `password_hash`). Returns `{ items, nextCursor }` keyset-paginated by `(created_at, id)` newest
  first (`limit`/`cursor`), with optional `?search=` matching email / display name / client `code`
  (case-insensitive). Each item is `{ id, email, displayName, code, createdAt, organizations }` where
  `organizations` is `[{ id, name }]` — the orgs the user currently belongs to (read from `users_orgs`
  in one extra batched query), so the FE can render membership and offer the right add/remove actions.
  Assigning a listed user to an org is then the existing `POST /organizations/:orgId/members`
  (`manage_org_members`), which 409s if they are already a member.
- `GET /users/me` — the caller's own profile: `{ id, email, displayName, code, isAdmin, credit,
  createdAt, updatedAt }`. Safe columns only — never `password_hash`.
- `PATCH /users/me` — update the caller's own profile. Body `UpdateProfileDto` (`displayName`,
  `password`); mirrors `UpdateUserDto` — `email` (and `code`) are intentionally absent, so with the
  global `forbidNonWhitelisted` they can't be changed here. A new password is re-hashed with `bcrypt`.
- `GET /users/me/credit` — `{ userId, credit, history }`: the caller's **global** wallet balance plus
  their credit ledger across **all** orgs (the wallet is one pool spanning orgs), newest first and
  cursor-paginated (`limit`/`cursor`, same keyset scheme as the other lists), backed by the
  `credit_history (user_id_fk, created_at desc, id desc)` index. This is the per-user read path, as
  opposed to `OrganizationService.getMemberCredit`, which scopes the ledger to a single org.

`UserModule` adds no new entities or tables — it reads/writes existing `users` columns and reads
`credit_history` and `users_orgs`. It does ship two migrations, though: `manage_all_users` is a new
seeded permission (`scripts/migrations/0002-seed-manage-all-users-permission.sql`), and `GET /users`
keyset-paginates on `users.created_at`, which was narrowed to `timestamp(3)` so the cursor round-trips
exactly (`scripts/migrations/0001-users-created-at-ms-precision.sql`) — the same reason the order /
credit-history `created_at` columns are `timestamp(3)`. `scripts/init.sql` is left untouched (reconciled
later), per **Environment / running locally**.

### Authorization: map-driven global guard
- **`src/rbac/permissions.config.ts` — `PERMISSION_API_MAP`** is the authored source of truth. It maps
  each permission **name** → the array of `"<method> <route path>"` routes it grants (lowercase method,
  Nest/Fastify route pattern, e.g. `add_user: ['post /organizations/users', ...]`), so one permission
  can gate many routes. Editing this map changes access at runtime — there are no per-route guards or
  decorators. **A route not listed in any permission's array is public.** The file derives
  `API_PERMISSION_MAP` (route → **list of** permission names) from it as a reverse index for the
  guard's O(1) lookup; don't edit that directly. A route may be claimed by several permissions (e.g.
  the order read routes) — the guard allows the caller if they hold **any** one of them.
- `PermissionsGuard` (`src/rbac/guards/`) is registered globally via `APP_GUARD` by `RbacModule`. Per request
  it builds the `"<method> <path>"` key and looks it up: not found → allow (public); found → verify
  the Bearer access token (`JwtService` + `JWT_ACCESS_SECRET`), set `request.user`, then allow if the
  user is `is_admin` **or** holds the required permission (via
  `OrganizationService.getEffectivePermissionNames(userId)`, across all their groups in any org).
  Route path comes from Fastify's `request.routeOptions.url`.
- `wh.permissions` rows are seeded by `scripts/init.sql` (the app does not seed at runtime). The
  permission *names* there must match the keys in `PERMISSION_API_MAP`.
- `is_admin` (`users.is_admin`, default false) is the system super-admin — bypasses all permission
  checks. It exists to bootstrap: an admin creates the first users and places them into an org /
  Admin group before any permission-holding user exists.
- `POST /organizations/users` (permission `add_user`) creates a user and attaches them to the
  `orgId` + `groupId` in the body (both required — the FE always sends the org/group being managed).
  The only authorization check is that the acting user **belongs to `orgId`** (admins excepted), so a
  hand-crafted request can't attach users to an org the caller isn't in. The group must belong to that
  org (else 404).

**Three access levels for a route:**
- **Permission-gated** — add the `"<method> <path>"` route to that permission's array in
  `PERMISSION_API_MAP` (creating the permission key if new, and inserting that permission name into
  `wh.permissions` with a `category`). No guard/controller code changes. Seeding a new permission row
  is a data change, so it needs a `scripts/migrations/NNNN-*.sql` like any other schema/data change
  (`init.sql` is left untouched).
- **Authenticated-only** (any logged-in user, no specific permission, e.g. `GET /organizations/me`) —
  leave it out of the map and put `@UseGuards(JwtAccessGuard)` on the route. The global guard treats
  unlisted routes as public and passes through; `JwtAccessGuard` then enforces auth and sets `req.user`.
- **Admin-only / bespoke** (no dedicated guard level exists) — do it authenticated-only (as above) and
  enforce the rule in the service from the acting user, e.g. the org-fee routes check `is_admin` and
  `GET .../members/:userId/credit` allows self / admin / `manage_org_members`.
- **Public** — leave it out of the map with no route guard.

### Auth endpoints (`AuthController`, prefix `auth`)
- `POST /auth/register` — body `RegisterDto`.
- `POST /auth/login` — body `LoginDto`; captures `user-agent` and IP.
- `POST /auth/refresh` — guarded by `JwtRefreshGuard`; rotates the refresh token.
- `POST /auth/logout` — body `{ refreshToken }`.

### Entities / schema
Postgres schema is `wh` (not `public`); table/column names are snake_case. `scripts/init.sql` is the
source of truth. Registered TypeORM entities (all in `src/entities/`): `User`, `RefreshToken`,
`Organization`, `UserOrg`, `OrgGroup`, `Permission`, `UserGroup`, `GroupPermission`, `Order`,
`OrderHistory`, `OrderSequence`, `OrgFee`, `CreditHistory`, `Shipment`, `ShipmentDetail`,
`ShipmentHistory`, `ShipmentSequence`.

**RBAC / multi-tenancy tables** (entity ↔ table):
- `Organization` → `organizations` — top-level tenant.
- `UserOrg` → `users_orgs` — user ↔ org membership (composite PK `user_id_fk, org_id_fk`).
- `OrgGroup` → `org_groups` — named groups (roles) scoped to an org (`name` unique per org).
- `Permission` → `permissions` — global permission catalog (`name` unique). `category`
  (`CHECK`-constrained: `order` | `shipment` | `organization` | `access_control`) groups each
  permission by functional area so the FE can render the catalog grouped — a fixed, developer-authored
  taxonomy mirroring the module layout, not a runtime-managed entity. The stored values are plain
  lowercase tokens the FE title-cases for display (`access_control` → "Access Control"). `PermissionCategory`
  enum lives on the entity; `listPermissions` orders by `(category, name)`, and `createPermission`
  (`POST /organizations/permissions/catalog`) requires a `category`.
- `UserGroup` → `user_groups` — user ↔ group assignment (composite PK `user_id_fk, group_id_fk`).
- `GroupPermission` → `group_permissions` — group ↔ permission grants (composite PK
  `group_id_fk, permission_id_fk`).

**Order tables** (entity ↔ table):
- `Order` → `orders` — an order placed into an org. `order_number` unique per org, `org_id_fk`,
  `user_id_fk` (the client who placed it), `qty` (numeric), `tracking` (`text`, NOT NULL — the client's
  free-text carrier reference/URL, supplied at placement), `status` (`CHECK`-constrained), and the
  review gate `locked` (when and by whom it was locked aren't stored on the order — they're the
  `LOCKED` `order_history` row's `created_at` / `changed_by_fk`). Composite index
  `orders_org_locked_created_idx (org_id_fk, locked, created_at desc, id desc)` backs the operations
  queue (the `locked = true` keyset scan).
- `OrderHistory` → `order_history` — append-only audit log (`change_type`, `prev_*`/`new_*` columns;
  `change_type` is `CREATED` | `STATUS_CHANGE` | `QTY_CHANGE` | `LOCKED`, `CHECK`-constrained).
  `changed_by_fk` → `wh.users`, exposed both as the raw `changedBy` uuid and as a `changedByUser`
  `@ManyToOne(User)` relation layered on the same column (loaded, with safe columns only, by
  `getHistory`).
- `OrderSequence` → `order_sequences` — per-`(user, org)` order-number counter (composite PK
  `user_id_fk, org_id_fk`); mutated via raw `ON CONFLICT` SQL, not the repository.
- `users.code` — per-user client code feeding order numbers (unique; NULLs allowed).
- `orders.shipped_qty` (`numeric`, default 0) — how much of `qty` has been shipped back out via locked
  shipments; `qty - shipped_qty` is what is still shippable, and the order auto-completes when it
  reaches `qty`.

**Shipment tables** (entity ↔ table; the mirror of the order tables — see **Shipment system** above):
- `Shipment` → `shipments` — a shipment placed into an org. `shipment_number` unique per org,
  `org_id_fk`, `user_id_fk` (the requesting client), `status` (`CHECK`: `REQUESTED` | `DELIVERED` |
  `CANCELLED`), the review gate `locked`, and nullable `tracking`. Composite indexes
  `shipments_org_created_idx` and `shipments_org_locked_created_idx` mirror the order queues.
- `ShipmentDetail` → `shipment_details` — the shipment ↔ order many-to-many line, composite PK
  `(shipment_id_fk, order_id_fk)` with a per-line `qty` (numeric). Reverse index on `order_id_fk`.
- `ShipmentHistory` → `shipment_history` — append-only audit log mirroring `order_history`
  (`change_type` is `CREATED` | `STATUS_CHANGE` | `ITEM_CHANGE` | `LOCKED`; `prev_qty`/`new_qty` hold
  the shipment's total qty; `changedByUser` joined on `changed_by_fk`).
- `ShipmentSequence` → `shipment_sequences` — per-`(user, org)` shipment-number counter, same shape and
  raw `ON CONFLICT` handling as `order_sequences`.

**Credit / billing tables** (entity ↔ table; see **Credit / billing** above):
- `users.credit` — per-user credit wallet (`numeric`, default 0), the balance charged on order/shipment
  lock.
- `OrgFee` → `org_fees` — per-org flat fee, composite PK `(org_id_fk, fee_type)`, `amount >= 0`;
  `fee_type` is `CHECK`-constrained (`ORDER_LOCK` | `SHIPMENT_LOCK`). No row = fee 0.
- `CreditHistory` → `credit_history` — append-only credit ledger. `entry_type` `CHECK`-constrained
  (`ORDER_LOCK` | `SHIPMENT_LOCK` | `TOP_UP` | `ADJUSTMENT`); **signed** `amount` with
  `prev_balance`/`new_balance` snapshots; nullable `order_id_fk` (→ `orders`) and nullable
  `shipment_id_fk` (→ `shipments`), both `on delete set null`, linking a charge to what triggered it.
  Indexed by `(user_id_fk, created_at desc, id desc)` and `(org_id_fk, created_at desc, id desc)` for
  the two ledger read paths, plus `order_id_fk` and `shipment_id_fk`.

Note: Postgres `numeric` columns come back as strings from TypeORM — the `Order`/`OrderHistory` qty
columns (including `orders.shipped_qty`), the `shipment_details`/`ShipmentHistory` qty columns,
`users.credit`, `org_fees.amount`, and the `credit_history` amount/balance columns all use
`numericTransformer` (`src/entities/numeric.transformer.ts`) to expose them as `number`.

Composite-key join entities map the raw uuid columns with `@PrimaryColumn` and layer the `@ManyToOne`
relation on the same column via `@JoinColumn` — follow that pattern for new junctions.

Permission resolution chain: **user → user_groups → org_groups → group_permissions → permissions**,
with the user's org scoping via `users_orgs`. All FKs cascade on update/delete. Reverse-lookup
indexes exist on the trailing FK columns (e.g. list members of an org / a group, find groups holding
a permission).

## Conventions / gotchas
- New join tables use a `_fk` column-name suffix (e.g. `user_id_fk`); the older `refresh_tokens`
  table uses a plain `user_id`. Match the surrounding table when adding columns.
- Composite join tables use a real composite `primary key`, not just a unique index.
- When adding an RBAC feature: create the entity, register it in `AppModule` (`entities` array +
  `forFeature`), add a feature module, and — per **Environment / running locally** — add a matching
  `scripts/migrations/NNNN-*.sql` and apply it to the running DB by hand (don't touch `init.sql`).
- **Any schema or seed/reference-data change requires a migration script** (`scripts/migrations/NNNN-*.sql`);
  `scripts/init.sql` is left untouched and reconciled later — see **Environment / running locally** for
  the full rule.
