# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

`warehouse-api`: a NestJS 11 (Fastify) backend. It implements JWT-based authentication
(register / login / refresh / logout), a **multi-tenant RBAC layer** (organizations, membership,
groups/roles, and permissions), an **order system** (org-scoped orders built from one or more
**line items** — each with its own quantity and receipt status — with a header status lifecycle
and an audit trail), a **shipment system** (org-scoped outbound shipments that draw quantity from
one or more warehoused **order line items**, mirroring the order flow — status lifecycle,
review-lock gate, and audit trail), an **inventory view** (read-only: the RECEIVED order line
items with stock left to ship, the basis for placing a shipment), a **credit / billing layer** (a per-user credit wallet charged a per-org fee when an
order or a shipment is locked — overridable per client by a **credit group** (a reseller markup
whose owner earns the difference) — plus ad-hoc, named **extra fees** staff add against an individual
order or shipment — with a full ledger), and a small **self-service layer** (the authenticated user
reads/updates their own profile and reviews their own wallet), all over a Postgres database in the
`wh` schema.

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
- **Object storage** (`StorageService`, for uploaded files such as top-up bills): `S3_ENDPOINT` (the
  storage host **only** — never append a folder), `S3_REGION` (default `auto`), `S3_BUCKET`,
  `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY`, `S3_FORCE_PATH_STYLE` (default `true`; required by Railway
  Buckets / MinIO / Garage), optional `S3_PREFIX` — a key prefix ("folder", e.g. `dev` / `prod`)
  prepended to every object to segregate environments that share one bucket (Railway already gives each
  environment its own bucket, so this is often unnecessary), and optional `S3_PUBLIC_ENDPOINT` — a
  browser-reachable host used **only** to sign presigned URLs (set it when `S3_ENDPOINT` is a
  private/internal endpoint; the signature is host-specific). Boot doesn't fail if these are unset; only
  calls that touch the bucket do.
- `ANTHROPIC_API_KEY` — present in `.env.sample` but not read anywhere in `src/` yet.

The server listens on `PORT` (default **3003**), bound to `0.0.0.0`. `main.ts` enables CORS for
`http://localhost:3000` (credentials on) and installs a global `ValidationPipe` with
`whitelist: true` + `forbidNonWhitelisted: true` — request bodies are validated against DTO
class-validator decorators and unknown properties are rejected.

## Architecture

### Module layout
- `AppModule` wires global `ConfigModule`, `ScheduleModule.forRoot()` (for cron jobs, e.g. bill
  expiry and shipment-label cleanup), the global `StorageModule`, a single async `TypeOrmModule.forRootAsync` (Postgres,
  schema `wh`, `synchronize: false`) registering every entity in `src/entities/`, a
  `TypeOrmModule.forFeature([User, RefreshToken])`, and the feature modules `AuthModule`,
  `OrganizationModule`, `RbacModule`, `OrderModule`, `ShipmentModule`, `InventoryModule`,
  `ExtraFeeModule`, and `UserModule`.
- `AuthModule` — registration/login/refresh/logout. Uses `@nestjs/jwt`, `bcrypt` for password
  hashing, and two Passport JWT strategies:
  - `jwt-access` (Bearer header) — guards ordinary endpoints via `JwtAccessGuard`.
  - `jwt-refresh` (reads `refreshToken` from the request **body**) — guards only `POST /auth/refresh`.
  Refresh tokens are stored server-side as hashes (`RefreshToken` entity) with rotation on refresh
  (old token revoked, new row issued). `user_agent` / `ip_address` are captured per token.
- `OrganizationModule` (`src/organization/`) — manages everything under an organization: the org
  itself, membership (users_orgs), groups/roles (org_groups), the global permission catalog
  (permissions), the group↔permission and user↔group wiring, and the **credit / billing layer**
  (per-org fees, **credit groups** (reseller markup), member credit top-ups, the credit-review
  endpoint, and **top-up bills** — see **Credit / billing**). It exports `OrganizationService` for reuse (by `RbacModule` for permission
  resolution, and by the order / shipment / self-service modules); it does **not** own the global guard.
  It also registers `CreditBillCleanupService` — a daily `@Cron` that expires bills older than two weeks
  via `OrganizationService.expireOldBills` — and injects the global `StorageService` for bill uploads.
- `RbacModule` (`src/rbac/`) — the authorization layer: registers the map-driven global
  `PermissionsGuard` (via `APP_GUARD`, so it runs on every route) and owns the authored
  `PERMISSION_API_MAP` source of truth (`src/rbac/permissions.config.ts`). Imports `OrganizationModule`
  for `OrganizationService` (permission resolution), plus `JwtModule` and the `User` repo the guard
  needs. Nothing imports `RbacModule` back, so the graph stays acyclic (Rbac → Organization → Auth);
  `AuthModule` stays a lean authN-only module and does **not** know a guard exists.
- `OrderModule` (`src/order/`) — the order system: place orders (a header plus one or more **line
  items** / `order_details`), manage their lines, drive the header status lifecycle, confirm per-line
  receipt, and read orders + history. Standalone module (not part of `OrganizationModule`); it imports
  `OrganizationModule` only to reuse `OrganizationService` (org existence, `assertOrgMembership`,
  `resolveUserCode`, `hasOrgPermission`). All order logic lives in `OrderService` — including the
  credit charge on lock, which reads `org_fees` and writes `credit_history` directly in its
  transaction. Both `OrderService` and `OrganizationService` (for the credit ledger) share the keyset
  pagination helper in `src/common/pagination.util.ts`.
- `ShipmentModule` (`src/shipment/`) — the shipment system: request shipments (each drawing quantity
  from one or more warehoused **order line items**), review/lock them, drive their status, and read
  shipments + history. Structurally the mirror of `OrderModule` — standalone, imports
  `OrganizationModule` only to reuse `OrganizationService`. All logic lives in `ShipmentService`,
  including the `SHIPMENT_LOCK` credit charge **and** the stock deduction on lock (it adds each line's
  qty to the order line item's `order_details.shipped_qty`, each detail row locked `FOR UPDATE`, all in
  the lock transaction; the order header is never touched). It also owns the **shipment label** image
  (client-uploaded, warehouse-printed) via the global `StorageService`, and registers
  `ShipmentLabelCleanupService` — a daily `@Cron` that deletes labels of `DONE`/`CANCELLED` shipments.
  Shares the keyset pagination helper.
- `InventoryModule` (`src/inventory/`) — a read-only view over warehoused inventory: `GET /inventory`
  lists the RECEIVED order line items (`order_details`) that still have stock left to ship
  (`qty - shipped_qty > 0`), the basis for placing a shipment. Standalone module (its own
  `InventoryService` over `forFeature([OrderDetail])`), imports `OrganizationModule` for
  `OrganizationService` (org existence, membership, permission checks). Gated in `PERMISSION_API_MAP`
  by the three shipment permissions; `InventoryService` applies shipment-style row scoping
  (`place_shipment` sees only their own lines, `review_shipment`/`process_shipment` and admins see all
  in the org). Shares the keyset pagination helper.
- `ExtraFeeModule` (`src/extra-fee/`) — the **fee** layer on an individual order or shipment, over the
  unified `total_fees` table (`TotalFee` entity): the protected **lock fee** plus ad-hoc **extra fees**.
  Standalone module (its own `ExtraFeeService`, two controllers `OrderFeeController` /
  `ShipmentFeeController`, over `forFeature([TotalFee, Order, Shipment])`); imports `OrganizationModule`
  only to reuse `OrganizationService` (membership + `hasOrgPermission`). One service serves both flows
  via an internal `FeeTarget` abstraction — the order and shipment routes are structurally identical.
  `CreditHistory` / `User` writes go through the shared transaction `EntityManager`. Shares the keyset
  pagination helper. See **Extra fees** below.
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
- `StorageModule` (`src/storage/`) — a `@Global` module exporting `StorageService`, a deliberately
  **feature-agnostic** wrapper over S3-compatible object storage (`@aws-sdk/client-s3`). Configured from
  `S3_*` env vars; runs on **Railway Buckets** in prod but works unchanged with Cloudflare R2 / MinIO /
  Garage / AWS S3. Methods: `put(key, body, contentType)`,
  `delete(key)`, `buildKey(prefix, filename, label?)` — a flat, unique key
  `[<S3_PREFIX>/]<prefix>/[<label>-]<uuid><ext>` (the optional `label`, e.g. an owning row id, is
  prepended for traceability; no extra path level; bill keys are `credit-bills/<entryId>-<uuid><ext>`,
  shipment-label keys `shipment-labels/<shipmentId>-<uuid><ext>`),
  and `getSignedUrl(key, expiresIn?, downloadFilename?)` — a short-lived **presigned GET URL** the
  browser opens directly (no bytes through the API), signed against `S3_PUBLIC_ENDPOINT` when set.
  It knows nothing about credit/bills — callers own the key scheme and any DB bookkeeping — so other
  features reuse it. Two consumers: **top-up bills** (see **Credit / billing** → **Top-up bills**) and
  **shipment labels** (see **Shipment system** → **Shipment labels**). Boot never fails when storage is
  unconfigured; only calls that touch
  the bucket do. File uploads arrive as `multipart/form-data` via `@fastify/multipart` (registered in
  `main.ts`, 1 file, 10 MB cap) and are read with the reusable `readSingleUploadedFile` helper
  (`src/common/uploaded-file.util.ts`, enforces content-type + size).

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
  ledger, cursor-paginated (each ledger row carries a `hasBill` boolean). See **Credit / billing** below.
- Top-up bills: `PUT /organizations/:orgId/members/:userId/credit/:entryId/bill` (requires
  `manage_org_members`) attaches **or replaces** the bill/receipt image on a `TOP_UP` entry
  (`multipart/form-data`, one file field; jpeg/png/webp/pdf, ≤10 MB — only the image changes, the
  top-up's amount/note/balances stay immutable). `DELETE .../credit/:entryId/bill` (requires
  `manage_org_members`) removes it. `GET .../credit/:entryId/bill` (authenticated-only; the service
  authorizes self / admin / `manage_org_members`, like the credit read) returns a **presigned URL**
  `{ url, expiresIn, contentType }` so the FE loads the image straight from the bucket, never proxying
  bytes through the API (`?download=true` forces a save dialog); the URL is valid for
  `BILL_URL_TTL_SECONDS` (7 days). See **Credit / billing** → **Top-up bills**.
- Fees (system-admin only): `POST|GET /organizations/:orgId/fees` — set / list an org's flat fees.
- Credit groups (system-admin only): `POST|GET /organizations/:orgId/credit-groups`,
  `GET|DELETE /organizations/:orgId/credit-groups/:creditGroupId`,
  `POST|GET /organizations/:orgId/credit-groups/:creditGroupId/fees` (set/list the group's per-`fee_type`
  amounts; each rejected below the org fee), and members
  `POST|GET /organizations/:orgId/credit-groups/:creditGroupId/members` /
  `DELETE .../members/:userId`. All **not** in `PERMISSION_API_MAP` (`@UseGuards(JwtAccessGuard)` +
  in-service `is_admin`, like org fees). See **Credit / billing** → **Credit groups**.
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
- `place_order` — a **client**: places orders, and while the order is still **unlocked** edits its
  header (`tracking`) and its **line items** (add / edit / remove lines) or cancels it; reads
  **only the orders they placed** (and those orders' history).
- `review_order` — a **reviewer**: reviews and **locks** an `IN_TRANSIT` order via
  `POST /orders/:orderId/lock`, edits a **locked** order's header/lines (but **not** its status or
  per-line receipt), and reads **every order in the org**. Locking freezes the client out and surfaces
  the order into the operations queue. Only `review_order` can lock.
- `process_order` — **operations staff**: drives a **locked** order's header status into the warehouse,
  confirms each line's **receipt status** (`PATCH /orders/:orderId/details/:detailId/status`), and
  reads **every *locked* order in the org** and its history.

The three read routes (`GET /orders`, `GET /orders/:orderId`, `GET /orders/:orderId/history`) are
reachable by **any** of these permissions — `PermissionsGuard` allows a route if the caller holds
*any* of its mapped permissions — and `OrderService` then applies the row-level scoping (via
`resolveAccess`, which checks all three with `OrganizationService.hasOrgPermission`, true for admins):
a reviewer (and admins) sees every order in the org, operations sees only `locked = true` orders, a
client sees only `order.userId = :userId`. A caller holding several permissions sees the **union**.
`getOrder` (also the gate for history and status updates) throws `404` when a caller touches an order
outside their scope, so they can't probe which orders exist. `listOrders` also accepts an optional
`?locked=true|false` filter (useful for a reviewer splitting their review queue from the processed set).

- `POST /orders` (`place_order`) — client places an order. Body `PlaceOrderDto` (`orgId`, **required
  non-empty** `details` — an array of `{ name, qty, note? }` line items, where `name` is free text the
  server prefixes with the client's code, **required** `tracking` — a free-text carrier reference/URL,
  since goods always ship via an external system, optional `note`). Created as `IN_TRANSIT`, unlocked,
  with each line `PENDING`. The order number is **always** auto-generated (there is no manual path).
- `GET /orders?orgId=:orgId` (`place_order` | `review_order` | `process_order`) — list an org's orders
  (`orgId` required query param), newest first; scoped per the roles above. Optional `?status=`,
  `?search=`, `?locked=` filters. Cursor-paginated (see below).
- `GET /orders/:orderId` (`place_order` | `review_order` | `process_order`) — one order; org derived
  from the order. Scoped per the roles above. The response carries the order's `details` (line items,
  oldest first), `totalQty` (their summed quantity), and `totalFee` — the sum of every non-voided fee
  on the order (the protected lock fee plus active extra fees), so the FE can show the running cost
  (`OrderService.getOrderDetail`).
- `PATCH /orders/:orderId` — edit the order **header** (`tracking`). Body `UpdateOrderDto` (`tracking`).
  Shared route, actor resolved by the lock gate: while **unlocked** only the owner (`place_order`), and
  only while `IN_TRANSIT`; while **locked** only a reviewer (`review_order`), up until a terminal state.
- `POST /orders/:orderId/details` — add a line. Body `AddOrderDetailDto` (`name`, `qty`, optional
  `note`). `PATCH /orders/:orderId/details/:detailId` — edit a line's `name`/`qty`/`note`
  (`UpdateOrderDetailDto`, all optional, ≥1 required). `DELETE /orders/:orderId/details/:detailId` —
  remove a line (an order must keep ≥1 line). All three are the **same lock-gated edit** as
  `PATCH /orders/:orderId` (owner pre-lock, reviewer post-lock) and write an `ITEM_ADDED` /
  `ITEM_UPDATED` / `ITEM_REMOVED` history row with the line's field diffs (see **Change tracking**).
- `PATCH /orders/:orderId/details/:detailId/status` (`process_order`) — operations confirms a line's
  **receipt**. Body `UpdateOrderDetailStatusDto` (`status` ∈ `RECEIVED`/`NOT_ARRIVED`/`CANCELLED`,
  optional `note`). Only after the order is **locked** and while non-terminal; writes an `ITEM_RECEIPT`
  row with the line's status diff. A `RECEIVED` line is a warehouse inventory unit.
- `PATCH /orders/:orderId/status` — move the order **header** status. Body `UpdateOrderStatusDto`
  (`status` ∈ `IN_TRANSIT`/`IN_WAREHOUSE`/`CANCELLED`, optional `note`); writes a `STATUS_CHANGED` row.
  Shared route, actor resolved by the lock gate: while **unlocked** only the owner (`place_order`) may
  move it (cancel); while **locked** only operations (`process_order`) may move it (into the warehouse,
  or cancel).
- `POST /orders/:orderId/lock` (`review_order`) — reviewer reviews and locks an `IN_TRANSIT` order.
  Body `LockOrderDto` (optional `note`). Writes a `LOCKED` history row. 400 if already locked or not
  `IN_TRANSIT`. **Locking is the billing event**: the order's *client* (`order.userId`, not
  the acting reviewer) is charged the org's `ORDER_LOCK` fee, and a 400 is returned if their credit
  can't cover it. See **Credit / billing** below.
- `GET /orders/:orderId/history` (`place_order` | `review_order` | `process_order`) — the order's audit trail, oldest
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

**Line items (`order_details`).** Quantity lives on the **lines**, not the order header — each line
has a `name` (the client's free text **slugified** and joined to their client `code` with a hyphen by
`OrderService.composeName` — lowercased, non-letter/digit runs → single hyphen, e.g. code `ACME` +
`"this is test"` → `ACME-this-is-test`), a `qty`, an optional `note`, and its own **receipt `status`**.
An order always has ≥1 line. `OrderService` re-derives the header total from the lines (`totalQty`)
rather than storing it.

**Header status lifecycle** (`OrderStatus` enum + a DB `CHECK`): just three managed states,
`IN_TRANSIT → IN_WAREHOUSE`, with `CANCELLED` reachable from either live state; `CANCELLED` is
terminal. `IN_TRANSIT` is the single initial state (it replaced the old `SHIPPING`/`ARRIVING` pair).
When operations moves an order to `IN_WAREHOUSE`, its lines are inventory items. The allowed moves are
**split by the lock gate** into two tables in `OrderService`:
- `CLIENT_TRANSITIONS` — what the owning client may do while **unlocked**: cancel an `IN_TRANSIT` order
  (line edits go through the `/details` routes, not a status move).
- `PROCESS_TRANSITIONS` — what operations may do once **locked**: `IN_TRANSIT → IN_WAREHOUSE`, or cancel.

`updateStatus` picks the table by `order.locked` and checks the actor (owner pre-lock, `process_order`
post-lock), so the client can never touch a locked order and operations can never touch an unlocked
one. Locking is thus the handoff: a reviewer locks an `IN_TRANSIT` order, after which the warehouse
lifecycle begins.

**Moving to `IN_WAREHOUSE` auto-receives the lines.** When operations moves a locked order to
`IN_WAREHOUSE` (`updateStatus`), every still-`PENDING` line is flipped to `RECEIVED` in the same
transaction (one `ITEM_RECEIPT` history row each); lines already resolved (`RECEIVED`/`NOT_ARRIVED`/
`CANCELLED`) are left untouched. Operations can still correct any line afterwards via the
`/details/:detailId/status` route. So warehousing an order is what turns its lines into shippable
inventory by default.

**Line receipt lifecycle** (`OrderDetailStatus` enum + a DB `CHECK` on `order_details.status`):
`PENDING → RECEIVED` / `NOT_ARRIVED` / `CANCELLED`. A line is created `PENDING` and auto-flipped to
`RECEIVED` when the order is warehoused (above); operations can also resolve/correct each line via
`PATCH /orders/:orderId/details/:detailId/status` (`DETAIL_TRANSITIONS` in `OrderService` allows
`RECEIVED ↔ NOT_ARRIVED` corrections; `CANCELLED` is terminal for a line). A `RECEIVED` line is a
warehouse inventory unit (a shipment draws from `qty - shipped_qty` of it); `NOT_ARRIVED` records a
line the client declared but that never reached the warehouse.

**Order numbers** are human-readable and generated per placement as `<user code>-<6-digit seq>`
(e.g. `ACME-000123`):
- `users.code` is a per-user client code, assigned at user creation (optional `code` in
  `CreateUserDto`, else derived from display name/email via `OrganizationService.resolveUserCode`).
  Self-registered users without one get a code lazily on their first order. The same `code` also
  prefixes each line item's `name`.
- `wh.order_sequences` is a per-`(user, org)` counter bumped atomically inside the place-order
  transaction (`INSERT ... ON CONFLICT (user_id_fk, org_id_fk) DO UPDATE SET next_seq = next_seq + 1
  RETURNING next_seq`). Because the sequence restarts per org, `order_number` is unique **per org**,
  not globally — enforced by the `orders_org_number_unique` unique index on
  `(org_id_fk, order_number)` (and guaranteed by construction, since `users.code` is globally unique
  and the sequence is atomic per `(user, org)`).
- `placeOrder` (order + its lines), `updateOrder`, the `/details` mutations, `lockOrder` and
  `updateStatus` each run in a single transaction that also writes an `order_history` row, so an order
  always has a matching audit entry. See **Change tracking** for the row shape.

**Change tracking.** `order_history` is a structured, append-only change log — one row per user action.
Each row has a `change_type` (the headline the FE renders without parsing) plus a `changes` **`jsonb`**
payload carrying the before/after detail (`OrderChange` in `order-history.entity.ts`), built by
`OrderService` helpers (`writeHistory` / `itemChange`). The `changes` shape is a normalized `{ from,
to }` diff:
- `changes.order` — header-field diffs (e.g. `{ tracking: { from, to } }`, `{ status: { from, to } }`,
  `{ locked: { from, to } }`).
- `changes.item` — a single line's change: `{ detailId, name (snapshot), fields: { qty|name|note|status:
  { from, to } } }` (the granular `/details` endpoints touch one line at a time; `ITEM_UPDATED` includes
  only the fields that actually changed, `ITEM_ADDED` carries `to`-only, `ITEM_REMOVED` `from`-only).
- `changes.items` — used **only** by `CREATED`, an array snapshotting every line at placement.

Change types: `CREATED` (order + all lines snapshot), `ORDER_UPDATED` (header edit), `STATUS_CHANGED`
(header status), `LOCKED`, `ITEM_ADDED` / `ITEM_UPDATED` / `ITEM_REMOVED` (line add/edit/remove),
`ITEM_RECEIPT` (line receipt status). The old typed diff columns (`prev_status`/`new_status`/
`prev_qty`/`new_qty`) and the `STATUS_CHANGE`/`QTY_CHANGE`/`ITEM_CHANGE` types are **gone**, superseded
by `changes`. The `note` column is a free-text *action* note (from a status/lock/receipt DTO) — a
line's own `note` is data captured inside `changes`, not here.

**Adding order permissions to a group:** the three permissions (`place_order`, `review_order`,
`process_order`) are seeded in `scripts/init.sql`; grant them to groups via the existing
group-permission endpoints — `place_order` to a client group (place/edit + read own orders),
`review_order` to a Review group (review/lock + read all orders), `process_order` to an Operations group
(process + read all locked orders in the org).

### Shipment system (`ShipmentController`, prefix `shipments`)
A **shipment** is a client's request to withdraw goods back out of the warehouse: it draws quantity
from one or more of the client's own warehoused **order line items** (`order_details`). The module is
the **mirror of the order system** — same top-level org-scoped resource shape, same three-role +
review/lock gate, same row-level scoping, same cursor pagination and audit trail — so most of the
order-system notes above apply verbatim, with these shipment-specific points:

**Shipment ↔ order line item is many-to-many.** One shipment can ship (say) 10 units from line A and 20
from line B. The per-line quantities live on the `shipment_details` junction (`Shipment.items`), keyed
`(shipment_id_fk, order_detail_id_fk)` with a `qty` column. A shipment only references order line items
the placing client owns, in the shipment's org, that are `RECEIVED` (warehoused inventory) with enough
**remaining** qty (`order_details.qty - order_details.shipped_qty`). Browse shippable inventory via
`GET /inventory` (see below); a shipment line references a line item's `detailId` as `orderDetailId`.

**Three roles + the review/lock gate** (identical structure to orders, resolved by
`ShipmentService.resolveAccess` via `OrganizationService.hasOrgPermission`):
- `place_shipment` — a **client**: requests shipments against their own warehoused line items, and while
  **unlocked** edits the line set (`PATCH /shipments/:shipmentId`) or cancels; manages the shipment's
  printable **label** (`PUT`/`DELETE /shipments/:shipmentId/label`); reads **only their own** shipments
  and history.
- `review_shipment` — a **reviewer**: reviews and **locks** an `AWAITING` shipment
  (`POST /shipments/:shipmentId/lock`); reads **every** shipment in the org. Only `review_shipment` can
  lock. (There is no reviewer edit-after-lock, unlike orders — a locked shipment's lines are fixed.)
- `process_shipment` — **operations**: drives a **locked** shipment to `DONE`/`CANCELLED`
  (`PATCH /shipments/:shipmentId/status`), and reads **every *locked*** shipment and its history.

The read routes (`GET /shipments`, `GET /shipments/:shipmentId`, `GET /shipments/:shipmentId/history`)
are reachable by any of the three; `ShipmentService` applies the same own/all/locked-only scoping and
`404`-on-out-of-scope as orders. `GET /shipments` takes a required `?orgId=`, optional `?status=`,
`?search=` (shipment number), `?locked=`, and keyset `limit`/`cursor`. Every read carries a `hasLabel`
boolean (whether a label image is attached) — batched on the list, joined on the detail. `GET
/shipments/:shipmentId` returns the shipment with its `items` (each carrying the referenced line item's
name/qty/shipped_qty/status and its order's number), plus `totalFee` — the sum of every non-voided fee
on it (lock fee + active extra fees), for the FE's running cost (`ShipmentService.getShipmentDetail`).

**Status lifecycle** (`ShipmentStatus` enum + DB `CHECK`): `AWAITING → DONE`, with `CANCELLED`
reachable from `AWAITING`; `DONE`/`CANCELLED` are terminal. `AWAITING` is the single initial state
(created by the client). Split by the lock gate in `ShipmentService`
(`CLIENT_SHIPMENT_TRANSITIONS` / `PROCESS_SHIPMENT_TRANSITIONS`): while **unlocked** only the owning
client may act (cancel an `AWAITING` shipment); once **locked** only operations may act (`DONE` or
`CANCELLED`). Locking does **not** change `status` (it stays `AWAITING`), exactly like orders.

**Lock is the billing + stock-deduction event** (`ShipmentService.lockShipment`, one transaction):
- the shipment's **client** (`shipment.userId`) is charged the org's flat `SHIPMENT_LOCK` fee — same
  `FOR UPDATE`/insufficient-credit/`fee 0 = no charge` mechanics as the order-lock charge, writing a
  `SHIPMENT_LOCK` `credit_history` row linked via the new `credit_history.shipment_id_fk`;
- each line's `qty` is added to the order line item's `order_details.shipped_qty` (each `order_details`
  row locked `FOR UPDATE` and re-checked against its `qty` so concurrent locks can't over-ship the same
  inventory); the order header is **never** touched (no status change, no `order_history` row);
- a `LOCKED` `shipment_history` row is written.

Cancelling a **locked** shipment (operations) **reverses the deduction**: it subtracts each line's qty
back from the order line item's `shipped_qty`, returning it to available inventory. The fee is **not**
refunded (mirrors orders). Cancelling an unlocked shipment moves nothing (nothing was deducted).

**Shipment numbers**: `<user code>-S<6-digit seq>` (e.g. `ACME-S000123`), from a per-`(user, org)`
`wh.shipment_sequences` counter bumped the same way as `order_sequences`; unique per org. **History**:
`shipment_history` mirrors `order_history` structurally — a `change_type` headline plus a `changes`
**`jsonb`** before/after payload (built by `ShipmentService.writeHistory` / `shipmentItemChange`): `changes.shipment`
holds header-field diffs (`status`, `locked`) and `changes.items` snapshots line items. Change types:
`CREATED` (placement, all lines snapshot), `STATUS_CHANGED` (header status), `LOCKED` (review), and
`ITEMS_CHANGED` — a client edit (`PATCH /shipments/:shipmentId`) replaces the line set and writes **one
summary row per edit**, with `changes.items` carrying every line that changed (added → qty to-only,
qty-updated → from+to, removed → from-only). A shipment line item snapshots the order line item it draws
from (`orderDetailId`, the referenced line's `name` and `orderNumber`, and the `qty` diff). The old typed
diff columns (`prev_status`/`new_status`/`prev_qty`/`new_qty`) and the `STATUS_CHANGE`/`ITEM_CHANGE` types
are **gone**, superseded by `changes`. `changedByUser` is joined on `changed_by_fk` the same way.

**Shipment labels.** A shipment carries a printable **shipping-label image** (e.g. a USPS label) the
warehouse prints — it replaced the old free-text `tracking` field. The image is stored in a **separate**
`shipment_labels` table (`ShipmentLabel` entity), mirroring `credit_resources` exactly: the row holds
the object-storage `object_key` (+ `content_type`, `size`, `created_at`) and a **unique**
`shipment_id_fk` (→ `shipments`, `on delete cascade`, one label per shipment); the bytes live in the
bucket via `StorageService`, never in the DB. Managed via `ShipmentService`
(`setLabel` / `getLabelUrl` / `deleteLabel`) over three routes:
- `PUT /shipments/:shipmentId/label` (`place_shipment`) — the owning **client** attaches or **replaces**
  the label (`multipart/form-data`, one file field; jpeg/png/webp/pdf, ≤10 MB via `readSingleUploadedFile`).
  Allowed only while the shipment is **non-terminal** (not `DONE`/`CANCELLED`); a re-upload writes a fresh
  object and deletes the old one.
- `GET /shipments/:shipmentId/label` (authenticated-only; the service authorizes via shipment
  visibility, so **anyone who can see the shipment** — client, reviewer, operations — can print it)
  returns a **presigned URL** `{ url, expiresIn, contentType }` the browser/print machine loads straight
  from the bucket, never proxying bytes (`?download=true` forces a save dialog); valid for
  `LABEL_URL_TTL_SECONDS` (7 days, `src/common/shipment-label.util.ts`).
- `DELETE /shipments/:shipmentId/label` (`place_shipment`) — the owning client removes it (row + object).

Unlike bills, labels are **not** age-expired — they're deleted once their shipment is `DONE`/`CANCELLED`
(a label is useless past then): `ShipmentService.expireLabelsForClosedShipments` (a daily `@Cron` in
`ShipmentLabelCleanupService`) drops those rows and their bucket objects.

**Adding shipment permissions to a group:** the three permissions (`place_shipment`, `review_shipment`,
`process_shipment`) are seeded in `scripts/init.sql` and mapped in `PERMISSION_API_MAP`; grant them to
groups exactly as the order permissions.

### Inventory (`InventoryController`, prefix `inventory`)
A read-only view of what is available to ship: the `RECEIVED` order line items (`order_details`) that
still have stock (`qty - shipped_qty > 0`). It is the browse-then-ship entry point — a client lists
their inventory, then references a line's `detailId` (as `orderDetailId`) in a shipment.
- `GET /inventory?orgId=:orgId` (`place_shipment` | `review_shipment` | `process_shipment`) — list an
  org's available inventory, newest line first, keyset-paginated (`limit`/`cursor`, same scheme as the
  order/shipment lists, keyed on `order_details (created_at, id)`). Optional `?search=` matches the
  order number or the line name (case-insensitive). Row scoping mirrors shipments: `place_shipment` sees
  only lines on the orders they placed; `review_shipment`/`process_shipment` and admins see every
  client's inventory in the org (`InventoryService.listInventory`). Each row is
  `{ detailId, orderId, orderNumber, clientId, name, qty, shippedQty, remaining, note, status,
  createdAt }`. No new permission — reuses the shipment role permissions.

### Fees (`OrderFeeController` / `ShipmentFeeController`, under `orders` / `shipments`)
Every fee charged against a single order or shipment lives in **one** table (`wh.total_fees`,
`TotalFee` entity), of two kinds distinguished by `is_protected`:
- the **lock fee** (`is_protected = true`) — written automatically when the order/shipment is locked,
  for the org's flat `ORDER_LOCK` / `SHIPMENT_LOCK` amount (see **Credit / billing**). Exactly one per
  target, and it **cannot be voided**.
- ad-hoc, **named** extra fees (`is_protected = false`) operations staff add (e.g. "Repackaging",
  "Storage overage"). These **can** be voided.

A row carries exactly one of `order_id_fk` / `shipment_id_fk` (a `CHECK` enforces it), mirroring how
`credit_history` carries both. All logic lives in `ExtraFeeService`, which normalizes the order/shipment
into an internal `FeeTarget` so one set of create/list/void routines handles both.

- `POST /orders/:orderId/fees` (`review_order` | `process_order`) and
  `POST /shipments/:shipmentId/fees` (`review_shipment` | `process_shipment`) — add an **extra** fee
  (`is_protected = false`). Body `CreateExtraFeeDto` (`name`, `amount > 0`, optional `note`). Allowed
  only while the target is **locked and non-terminal** (400 otherwise). **Saving is the billing event**:
  in one transaction the target's **client** (`order.userId` / `shipment.userId`, not the acting
  staffer) is charged — the client's row `SELECT … FOR UPDATE`d, `400` on insufficient credit, deducted
  — and the `total_fees` row plus a signed-negative `EXTRA_FEE` `credit_history` row (linked via
  `fee_id_fk` and the target's `order_id_fk`/`shipment_id_fk`) are written.
- `GET /orders/:orderId/fees` (`place_order` | `review_order` | `process_order`) and the shipment mirror
  — list **all** of a target's fees (the protected lock fee and every extra fee, in one query), newest
  first, cursor-paginated. Same own/all/locked row-level scoping as the order/shipment reads (so a client
  can see the fees they were charged; 404 when the target isn't visible). Each row joins `createdByUser`
  / `voidedByUser` (safe columns only) and carries `isProtected` so the FE knows the lock fee isn't
  voidable.
- `DELETE /orders/:orderId/fees/:feeId` (`review_order` | `process_order`) and the shipment mirror —
  **void** an extra fee (staff only). `400` if the fee is **protected** (the lock fee) or already voided.
  The row is **immutable**: voiding stamps `voided_at`/`voided_by_fk` and writes a **reversing**
  `EXTRA_FEE` (positive `amount`) ledger row that refunds the client, keeping the ledger append-only and
  earnings self-netting.

Auth/permissions come from the global `PermissionsGuard` via `PERMISSION_API_MAP` (the routes are mapped
to the existing order/shipment role permissions); `ExtraFeeService` then re-checks org membership and the
per-org role, so a permission held in one org can't act in another — like the order/shipment routes.

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
  **same transaction** as the lock + `LOCKED` history row, always writes a **protected** `total_fees`
  row (`is_protected = true`, name "Order lock fee", the fee amount — even when 0), then charges the
  order's **client** (`order.userId`, not the acting reviewer): it `SELECT … FOR UPDATE`s the client's
  row (so concurrent charges/top-ups can't overdraw), throws `400` if `credit < fee`, deducts, and
  writes an `ORDER_LOCK` ledger row linked to the fee row via `fee_id_fk`. A fee of 0 charges nothing
  and writes no ledger row, but the protected `total_fees` row (amount 0) is still recorded. The amount
  charged is the org fee **unless the client is in a credit group** that overrides it — see **Credit
  groups** below (the charged amount, and any owner commission, are resolved by
  `resolveClientFee`/`creditCommission` in `src/common/credit-group.util.ts`).
- **The charge (shipment lock).** `ShipmentService.lockShipment` charges the shipment's **client** the
  org's `SHIPMENT_LOCK` fee identically — a protected "Shipment lock fee" `total_fees` row plus (when
  the fee > 0) a `SHIPMENT_LOCK` ledger row linked via `credit_history.shipment_id_fk` (rather than
  `order_id_fk`) — again subject to the client's **credit group** override. See the **Shipment system** above.
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
- **Extra fees.** Beyond the flat lock fees, staff add **ad-hoc, named fees** against an individual
  order or shipment (`ExtraFeeService`), charged to the client the same way — a `FOR UPDATE`/
  insufficient-credit (`400`)/deduct transaction that writes an `EXTRA_FEE` ledger row linked via
  `credit_history.fee_id_fk`. Both the lock fee and extra fees share the `total_fees` table. See the
  dedicated **Fees** section above.
- **Credit groups (reseller markup).** A **credit group** is a billing-only construct, deliberately
  **separate from the permission `org_groups`** — it exists only to mark up the flat lock fee for a set
  of clients. A group (`wh.credit_groups`, `CreditGroup`) is scoped to an org, has an **owner**
  (`owner_id_fk` → the reviewer/reseller who earns the markup, and must be an org member), its own
  per-`fee_type` amounts (`credit_group_fees`, mirroring `org_fees`), and client **members**
  (`credit_group_members`, unique `(user_id_fk, org_id_fk)` so a client is in **at most one credit group
  per org** — keeping fee resolution unambiguous). On lock, if the client belongs to a credit group with
  a fee for that `fee_type`, the **group fee overrides the org fee** as what the client is charged; the
  split is: the **client** pays the group fee, the **warehouse** keeps the org fee (the base), and the
  group **owner's wallet is credited** `group fee − org fee` via a positive `RESELLER_COMMISSION` ledger
  row (linked to the triggering order/shipment and lock fee). A group fee is **floored at the org fee**
  (enforced when set, and defensively at charge time) so the owner's markup is never negative. Resolution
  and the owner credit live in `src/common/credit-group.util.ts` (`resolveClientFee` / `creditCommission`),
  called from both `lockOrder` and `lockShipment`; management is **system-admin only** (see the org
  endpoints above). A client in no credit group (or a group with no fee for that type) is charged the
  plain org fee, exactly as before.
- **The ledger** (`credit_history`). One row per change: `entry_type`
  (`ORDER_LOCK` | `SHIPMENT_LOCK` | `EXTRA_FEE` | `TOP_UP` | `ADJUSTMENT` | `RESELLER_COMMISSION`), a
  **signed** `amount` (negative = a charge, positive = top-up/refund/void/**commission**) so
  `new_balance = prev_balance + amount` always
  holds, a nullable `order_id_fk` (set on an `ORDER_LOCK` charge, an order extra fee, or an order-lock
  commission) **and** a nullable `shipment_id_fk` (set on a `SHIPMENT_LOCK` charge, a shipment extra fee,
  or a shipment-lock commission) **and** a nullable
  `fee_id_fk` (→ `total_fees`, set on a lock-fee, `EXTRA_FEE`, or commission row) linking a movement to
  what triggered it, and the `org_id_fk` the movement happened in.
- **Warehouse earnings** over a period for an org = `-SUM(amount)` over the charge entry types
  (`ORDER_LOCK`, `SHIPMENT_LOCK`, `EXTRA_FEE`, **`RESELLER_COMMISSION`**) in `credit_history` — top-ups
  (positive) are excluded, and because both an extra-fee void (a positive `EXTRA_FEE` reversal) and an
  owner commission (a positive `RESELLER_COMMISSION` credit) are positive, subtracting them nets out:
  a void cancels its original charge, and a commission brings a marked-up client charge back down to the
  org base the warehouse actually keeps. A reviewer's own earnings = `SUM(amount)` over their
  `RESELLER_COMMISSION` rows. (No earnings query is implemented in code yet — this is report-level.)
- **Top-up bills.** A `TOP_UP` entry can carry one bill/receipt image, stored in a **separate**
  `credit_resources` table (`CreditResource` entity) rather than on `credit_history` — deliberately kept
  off the append-only ledger so it stays lean and the image data can be cleaned up independently. The row
  holds the object-storage `object_key` (+ `content_type`, `size`, `created_at`) and a **unique**
  `credit_id_fk` (→ `credit_history`, `on delete cascade`), enforcing one bill per entry; the image bytes
  live in the bucket via `StorageService`, never in the DB. Managed via `OrganizationService`
  (`setTopUpBill` / `getTopUpBillUrl` / `deleteTopUpBill`) over the `PUT|GET|DELETE
  .../credit/:entryId/bill` routes (see the org endpoints above; the `GET` returns a presigned URL, not
  the bytes); a re-upload writes a fresh object and deletes the old one, and only the image ever changes
  (the ledger entry is immutable).
  The FE views a bill **only** via `getTopUpBillUrl`, which returns a **presigned URL** the browser
  fetches directly from the bucket — bill bytes never pass through the API (there is no server-side
  streaming route). Two independent knobs in `src/common/credit-bill.util.ts`: `BILL_TTL_DAYS` (14,
  retention → the cleanup cron) and `BILL_URL_TTL_SECONDS` (7 days, presigned-URL lifetime — kept at the
  standard SigV4 max so URLs stay valid on R2 / MinIO / AWS too, not just Railway Buckets which allow up
  to 90 days). The two
  credit-ledger read paths (`getMemberCredit`, `UserService.getMyCredit`) `leftJoin` this table and
  expose a `hasBill` boolean per row via `attachBillFlag` (`src/common/credit-bill.util.ts`) — the raw
  `object_key` is never returned to clients. **Bills auto-expire after 14 days**: `expireOldBills` (a
  daily `@Cron` in `CreditBillCleanupService`) deletes `credit_resources` rows older than the TTL and
  their bucket objects. (A cron is used because Railway Buckets' native S3 lifecycle-rule support isn't
  documented; if confirmed, it can be replaced by a bucket lifecycle rule.)

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
`credit_history` and `users_orgs`. Its two schema/seed changes — the new seeded `manage_all_users`
permission, and narrowing `users.created_at` to `timestamp(3)` so the `GET /users` keyset cursor
round-trips exactly (the same reason the order / credit-history `created_at` columns are `timestamp(3)`)
— shipped as migrations applied by hand to the running DB. Those files are **no longer in
`scripts/migrations/`** (the current sequence restarts at `0001`) and are **not yet folded into
`scripts/init.sql`** either, so a DB freshly bootstrapped from `init.sql` still lacks them; reconcile
them into `init.sql` when it is next brought up to date, per **Environment / running locally**.

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
`OrderDetail`, `OrderHistory`, `OrderSequence`, `OrgFee`, `CreditHistory`, `CreditResource`,
`Shipment`, `ShipmentDetail`, `ShipmentHistory`, `ShipmentLabel`, `ShipmentSequence`, `TotalFee`,
`CreditGroup`, `CreditGroupFee`, `CreditGroupMember`.

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
- `Order` → `orders` — an order **header** placed into an org. `order_number` unique per org
  (`orders_org_number_unique` on `(org_id_fk, order_number)`), `org_id_fk`, `user_id_fk` (the client
  who placed it), `tracking` (`text`, NOT NULL — the client's
  free-text carrier reference/URL, supplied at placement), `status` (`CHECK`-constrained:
  `IN_TRANSIT` | `IN_WAREHOUSE` | `CANCELLED`), and the
  review gate `locked` (when and by whom it was locked aren't stored on the order — they're the
  `LOCKED` `order_history` row's `created_at` / `changed_by_fk`). Composite index
  `orders_org_locked_created_idx (org_id_fk, locked, created_at desc, id desc)` backs the operations
  queue (the `locked = true` keyset scan). The header's old scalar `qty` **and** `shipped_qty` columns
  have both been **dropped** — quantity lives on `order_details`, and shipped quantity is now per-line
  too (the order header is never touched by shipments). The deprecated `COMPLETED` status has been
  removed from the enum and the DB `CHECK`.
- `OrderDetail` → `order_details` — an order's **line items** (where quantity now lives). `order_id_fk`
  (→ `orders`, `on delete cascade`), `name` (`varchar(255)` — the client's free text slugified and
  hyphen-joined to their client `code`, e.g. `ACME-this-is-test`), `qty` (numeric), `shipped_qty`
  (numeric, default 0 — how much of this line has been shipped back out; `qty - shipped_qty` is the
  line's remaining inventory, bumped/reversed by `ShipmentService` on lock/cancel), optional `note`,
  and `status` (`CHECK`-constrained:
  `PENDING` | `RECEIVED` | `NOT_ARRIVED` | `CANCELLED` — the per-line receipt lifecycle; a `RECEIVED`
  line with stock left is an inventory unit a shipment draws from). Reverse index
  `order_details_order_idx` on `order_id_fk`.
- `OrderHistory` → `order_history` — append-only structured change log. `change_type`
  (`CHECK`-constrained: `CREATED` | `ORDER_UPDATED` | `STATUS_CHANGED` | `LOCKED` | `ITEM_ADDED` |
  `ITEM_UPDATED` | `ITEM_REMOVED` | `ITEM_RECEIPT`), a `changes` **`jsonb`** before/after payload (see
  **Change tracking** above), and a free-text `note`. The old typed diff columns
  (`prev_*`/`new_*`) were dropped. `changed_by_fk` → `wh.users`, exposed both as the raw `changedBy`
  uuid and as a `changedByUser` `@ManyToOne(User)` relation layered on the same column (loaded, with
  safe columns only, by `getHistory`).
- `OrderSequence` → `order_sequences` — per-`(user, org)` order-number counter (composite PK
  `user_id_fk, org_id_fk`); mutated via raw `ON CONFLICT` SQL, not the repository.
- `users.code` — per-user client code feeding order numbers **and** each line item's `name` prefix
  (unique; NULLs allowed).

**Shipment tables** (entity ↔ table; the mirror of the order tables — see **Shipment system** above):
- `Shipment` → `shipments` — a shipment placed into an org. `shipment_number` unique per org,
  `org_id_fk`, `user_id_fk` (the requesting client), `status` (`CHECK`: `AWAITING` | `DONE` |
  `CANCELLED`), and the review gate `locked`. Composite indexes
  `shipments_org_created_idx` and `shipments_org_locked_created_idx` mirror the order queues. (The old
  free-text `tracking` column has been **dropped** — replaced by the `shipment_labels` image; see below.)
- `ShipmentDetail` → `shipment_details` — the shipment ↔ **order line item** many-to-many line,
  composite PK `(shipment_id_fk, order_detail_id_fk)` with a per-line `qty` (numeric). `order_detail_id_fk`
  → `order_details` (`on delete cascade`). Reverse index `shipment_details_order_detail_id_idx` on
  `order_detail_id_fk`. (Phase 2 repointed this off the order header's `order_id_fk`.)
- `ShipmentHistory` → `shipment_history` — append-only structured change log mirroring `order_history`.
  `change_type` (`CHECK`-constrained: `CREATED` | `STATUS_CHANGED` | `LOCKED` | `ITEMS_CHANGED`), a
  `changes` **`jsonb`** before/after payload (`ShipmentChange` in
  `shipment-history.entity.ts`; reuses order's `FieldDiff`), and a free-text `note`. The old typed diff
  columns (`prev_status`/`new_status`/`prev_qty`/`new_qty`) were dropped. `changedByUser` joined on
  `changed_by_fk`.
- `ShipmentSequence` → `shipment_sequences` — per-`(user, org)` shipment-number counter, same shape and
  raw `ON CONFLICT` handling as `order_sequences`.
- `ShipmentLabel` → `shipment_labels` — the printable shipping-label image for a shipment (replaces the
  old `tracking` field). Mirrors `credit_resources`: `object_key` (the S3 key), `content_type`, `size`
  (`bigint`, `numericTransformer`), `created_at` (`timestamp(3)`), and a **unique** `shipment_id_fk`
  (→ `shipments`, `on delete cascade`) enforcing one label per shipment. Bytes live in object storage,
  never here. A `label` `@OneToOne(ShipmentLabel)` relation (inverse side, no column) is layered on
  `Shipment` for the `hasLabel` flag. Deleted by a daily cron once the shipment is `DONE`/`CANCELLED`
  (see **Shipment system** → **Shipment labels**).

**Credit / billing tables** (entity ↔ table; see **Credit / billing** above):
- `users.credit` — per-user credit wallet (`numeric`, default 0), the balance charged on order/shipment
  lock.
- `OrgFee` → `org_fees` — per-org flat fee, composite PK `(org_id_fk, fee_type)`, `amount >= 0`;
  `fee_type` is `CHECK`-constrained (`ORDER_LOCK` | `SHIPMENT_LOCK`). No row = fee 0.
- `CreditHistory` → `credit_history` — append-only credit ledger. `entry_type` `CHECK`-constrained
  (`ORDER_LOCK` | `SHIPMENT_LOCK` | `EXTRA_FEE` | `TOP_UP` | `ADJUSTMENT` | `RESELLER_COMMISSION`);
  **signed** `amount` with
  `prev_balance`/`new_balance` snapshots; nullable `order_id_fk` (→ `orders`), nullable
  `shipment_id_fk` (→ `shipments`), and nullable `fee_id_fk` (→ `total_fees`), all `on delete set
  null`, linking a movement to what triggered it. Indexed by `(user_id_fk, created_at desc, id desc)` and
  `(org_id_fk, created_at desc, id desc)` for the two ledger read paths, plus `order_id_fk`,
  `shipment_id_fk`, and `fee_id_fk`. A `resource` `@OneToOne(CreditResource)` relation (inverse side,
  no column) is layered on for the `hasBill` flag — see below.
- `CreditResource` → `credit_resources` — a file attached to a credit entry (today a `TOP_UP`'s
  bill/receipt image), kept off `credit_history` so the ledger stays lean and the data can be cleaned up
  independently. `object_key` (the S3 key), `content_type`, `size` (`bigint`, `numericTransformer`),
  `created_at` (`timestamp(3)`), and a **unique** `credit_id_fk` (→ `credit_history`, `on delete
  cascade`) enforcing one resource per entry. Bytes live in object storage (`StorageService`), never
  here. Indexes: unique `credit_resources_credit_unique (credit_id_fk)` and
  `credit_resources_created_idx (created_at)` (backs the daily expiry scan). See **Credit / billing** →
  **Top-up bills**.
- `TotalFee` → `total_fees` — every fee on one order **or** one shipment: `name`, `amount`
  (`numeric`, `CHECK amount >= 0`), `is_protected` (`boolean`, default false — true = the non-voidable
  lock fee, false = a voidable extra fee), `org_id_fk`, mutually-exclusive nullable `order_id_fk` /
  `shipment_id_fk` (`CHECK` exactly one set, both `on delete cascade`), `created_by_fk`, optional `note`,
  and `voided_at` / `voided_by_fk` (a void, never a delete). `created_by_fk` / `voided_by_fk` expose
  `createdByUser` / `voidedByUser` `@ManyToOne(User)` relations (safe columns only). Composite indexes
  `total_fees_order_created_idx` / `total_fees_shipment_created_idx` back the per-target keyset lists.
- `CreditGroup` → `credit_groups` — a billing-only client group that marks up the flat lock fee
  (separate from the permission `org_groups`). `id`, `name`, `org_id_fk` (→ `organizations`),
  `owner_id_fk` (→ `users`, the reviewer who earns the markup; an `owner` `@ManyToOne(User)` relation,
  safe columns only), `created_at` (`timestamp(3)`), `updated_at`. Unique `(org_id_fk, name)`; reverse
  indexes on `org_id_fk` and `owner_id_fk`. `fees` / `members` are `@OneToMany` inverse relations. See
  **Credit / billing** → **Credit groups**.
- `CreditGroupFee` → `credit_group_fees` — a credit group's per-action fee, mirroring `org_fees`:
  composite PK `(credit_group_id_fk, fee_type)`, `amount >= 0`, `fee_type` `CHECK`-constrained
  (`ORDER_LOCK` | `SHIPMENT_LOCK`). No row = no override for that action (falls back to the org fee).
- `CreditGroupMember` → `credit_group_members` — client ↔ credit group, composite PK
  `(credit_group_id_fk, user_id_fk)` with a denormalized `org_id_fk` backing a **unique**
  `(user_id_fk, org_id_fk)` index (a client is in at most one credit group per org). `created_at`
  (`timestamp(3)`); reverse index on `credit_group_id_fk`.

Note: Postgres `numeric` columns come back as strings from TypeORM —
`order_details.qty` and `order_details.shipped_qty`, the
`shipment_details.qty` column, `users.credit`, `org_fees.amount`, `credit_group_fees.amount`,
`total_fees.amount`, the `credit_history` amount/balance columns, `credit_resources.size` and
`shipment_labels.size` all use
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
