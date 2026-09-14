create schema wh;
set schema 'wh';

create table users
(
    id            uuid                     default gen_random_uuid() not null
        primary key,
    email         varchar                                            not null,
    password_hash varchar                                            not null,
    display_name  varchar                                            not null,
    is_admin      boolean                  default false             not null,
    created_at    timestamp with time zone default now()             not null,
    updated_at    timestamp with time zone,
    code          varchar(16),
    -- Money the user manages, in the org's billing units. Charged when an order
    -- is locked (and, later, for shipment requests). A user cannot incur a charge
    -- that would take this below zero. Every change is mirrored in credit_history.
    credit        numeric                  default 0                 not null
);

create unique index user_unique
    on users (email);

create unique index user_code_unique
    on users (code);

create table refresh_tokens
(
    id         uuid                     default gen_random_uuid() not null
        primary key,
    user_id    uuid                                               not null
        references users
            on update cascade on delete cascade,
    token_hash varchar                                            not null,
    user_agent varchar,
    ip_address varchar,
    expires_at timestamp with time zone                           not null,
    revoked_at timestamp with time zone,
    created_at timestamp with time zone default now()
);

create table organizations
(
    id         uuid                     default gen_random_uuid() not null
        primary key,
    name       varchar(255)                                       not null,
    created_at timestamp with time zone default now()             not null,
    updated_at timestamp with time zone
);

create table users_orgs
(
    user_id_fk uuid                                   not null
        references users
            on update cascade on delete cascade,
    org_id_fk  uuid                                   not null
        references organizations
            on update cascade on delete cascade,
    created_at timestamp with time zone default now() not null,
    primary key (user_id_fk, org_id_fk)
);

create index users_orgs_org_id_idx
    on users_orgs (org_id_fk);

create table org_groups
(
    id          uuid                     default gen_random_uuid() not null
        primary key,
    name        varchar(255)                                       not null,
    org_id_fk   uuid                                               not null
        references organizations
            on update cascade on delete cascade,
    created_at  timestamp with time zone default now()             not null,
    updated_at  timestamp with time zone,
    is_editable boolean                  default true              not null
);

create unique index org_group_unique
    on org_groups (name, org_id_fk);

create index org_groups_org_id_idx
    on org_groups (org_id_fk);

create table permissions
(
    id                  uuid    default gen_random_uuid() not null
        primary key,
    name                varchar(255)                      not null,
    description         text                              not null,
    is_group_permission boolean default false             not null
);

create unique index permission_unique
    on permissions (name);

create table user_groups
(
    user_id_fk  uuid                                   not null
        references users
            on update cascade on delete cascade,
    group_id_fk uuid                                   not null
        references org_groups
            on update cascade on delete cascade,
    created_at  timestamp with time zone default now() not null,
    primary key (user_id_fk, group_id_fk)
);

create index user_groups_group_id_idx
    on user_groups (group_id_fk);

create table group_permissions
(
    group_id_fk      uuid                                   not null
        references org_groups
            on update cascade on delete cascade,
    permission_id_fk uuid                                   not null
        references permissions
            on update cascade on delete cascade,
    created_at       timestamp with time zone default now() not null,
    primary key (group_id_fk, permission_id_fk)
);

create index group_permissions_permission_id_idx
    on group_permissions (permission_id_fk);

create table orders
(
    id           uuid                        default gen_random_uuid()             not null
        primary key,
    order_number varchar(255)                                                      not null,
    org_id_fk    uuid                                                              not null
        references organizations
            on update cascade on delete cascade,
    user_id_fk   uuid                                                              not null
        references users
            on update cascade,
    qty          numeric                                                           not null,
    -- How much of qty has been shipped back out via locked shipments. qty stays the
    -- immutable ordered total; qty - shipped_qty is what is still available to ship.
    -- When shipped_qty reaches qty the order is moved to COMPLETED.
    shipped_qty  numeric                     default 0                             not null,
    tracking     text                                                              not null,
    status       varchar(50)                 default 'SHIPPING'::character varying not null
        constraint orders_status_check
            check ((status)::text = ANY
                   ((ARRAY ['SHIPPING'::character varying, 'ARRIVING'::character varying, 'IN_WAREHOUSE'::character varying, 'COMPLETED'::character varying, 'CANCELLED'::character varying])::text[])),
    locked       boolean                     default false                         not null,
    created_at   timestamp(3) with time zone default now()                         not null,
    updated_at   timestamp with time zone
);

create index orders_org_created_idx
    on orders (org_id_fk asc, created_at desc, id desc);

create index orders_org_locked_created_idx
    on orders (org_id_fk asc, locked asc, created_at desc, id desc);

create index orders_user_id_idx
    on orders (user_id_fk);

create table order_sequences
(
    user_id_fk uuid             not null
        references users
            on update cascade on delete cascade,
    org_id_fk  uuid             not null
        references organizations
            on update cascade on delete cascade,
    next_seq   bigint default 0 not null,
    primary key (user_id_fk, org_id_fk)
);

create table order_history
(
    id            uuid                        default gen_random_uuid() not null
        primary key,
    order_id_fk   uuid                                                  not null
        references orders
            on update cascade on delete cascade,
    changed_by_fk uuid                                                  not null
        references users
            on update cascade,
    change_type   varchar(50)                                           not null
        constraint order_history_change_type_check
            check ((change_type)::text = ANY
                   ((ARRAY ['CREATED'::character varying, 'STATUS_CHANGE'::character varying, 'QTY_CHANGE'::character varying, 'LOCKED'::character varying])::text[])),
    prev_status   varchar(50),
    new_status    varchar(50),
    prev_qty      numeric,
    new_qty       numeric,
    note          text,
    created_at    timestamp(3) with time zone default now()             not null
);

create index order_history_order_created_idx
    on order_history (order_id_fk, created_at, id);

-- A shipment: a client's request to withdraw some quantity out of one or more of
-- their warehoused orders. The per-order quantities live on shipment_details. The
-- mirror of `orders`: same review-lock gate (locking charges the SHIPMENT_LOCK
-- fee and deducts the shipped qty from each order), same audit trail, same numbering.
create table shipments
(
    id              uuid                        default gen_random_uuid()               not null
        primary key,
    shipment_number varchar(255)                                                        not null,
    org_id_fk       uuid                                                                not null
        references organizations
            on update cascade on delete cascade,
    user_id_fk      uuid                                                                not null
        references users
            on update cascade,
    status          varchar(50)                 default 'REQUESTED'::character varying  not null
        constraint shipments_status_check
            check ((status)::text = ANY
                   ((ARRAY ['REQUESTED'::character varying, 'DELIVERED'::character varying, 'CANCELLED'::character varying])::text[])),
    locked          boolean                     default false                           not null,
    tracking        text,
    created_at      timestamp(3) with time zone default now()                           not null,
    updated_at      timestamp with time zone
);

create index shipments_org_created_idx
    on shipments (org_id_fk asc, created_at desc, id desc);

create index shipments_org_locked_created_idx
    on shipments (org_id_fk asc, locked asc, created_at desc, id desc);

create index shipments_user_id_idx
    on shipments (user_id_fk);

-- Shipment detail lines: the many-to-many between a shipment and the orders it
-- draws from, carrying the qty shipped out of each order in that shipment. Composite
-- PK => each order appears at most once per shipment.
create table shipment_details
(
    shipment_id_fk uuid    not null
        references shipments
            on update cascade on delete cascade,
    order_id_fk    uuid    not null
        references orders
            on update cascade on delete cascade,
    qty            numeric not null,
    primary key (shipment_id_fk, order_id_fk)
);

create index shipment_details_order_id_idx
    on shipment_details (order_id_fk);

-- Append-only audit trail for a shipment (the mirror of order_history). prev_qty /
-- new_qty hold the shipment's total quantity (summed across its order lines).
create table shipment_history
(
    id             uuid                        default gen_random_uuid() not null
        primary key,
    shipment_id_fk uuid                                                  not null
        references shipments
            on update cascade on delete cascade,
    changed_by_fk  uuid                                                  not null
        references users
            on update cascade,
    change_type    varchar(50)                                           not null
        constraint shipment_history_change_type_check
            check ((change_type)::text = ANY
                   ((ARRAY ['CREATED'::character varying, 'STATUS_CHANGE'::character varying, 'ITEM_CHANGE'::character varying, 'LOCKED'::character varying])::text[])),
    prev_status    varchar(50),
    new_status     varchar(50),
    prev_qty       numeric,
    new_qty        numeric,
    note           text,
    created_at     timestamp(3) with time zone default now()             not null
);

create index shipment_history_shipment_created_idx
    on shipment_history (shipment_id_fk, created_at, id);

-- Per-(user, org) shipment-number counter (the mirror of order_sequences).
create table shipment_sequences
(
    user_id_fk uuid             not null
        references users
            on update cascade on delete cascade,
    org_id_fk  uuid             not null
        references organizations
            on update cascade on delete cascade,
    next_seq   bigint default 0 not null,
    primary key (user_id_fk, org_id_fk)
);

-- Per-organization, flat fee catalog. One row per (org, fee_type): the predefined
-- amount charged for that action in that org. `fee_type` is open-ended so the same
-- table serves the order-lock fee today and the upcoming shipment-request fee.
-- Orgs with no row for a fee_type are treated as fee 0 (not charged) — insert a row
-- to switch charging on for an org.
create table org_fees
(
    org_id_fk  uuid                                   not null
        references organizations
            on update cascade on delete cascade,
    fee_type   varchar(50)                            not null
        constraint org_fees_fee_type_check
            check ((fee_type)::text = ANY
                   ((ARRAY ['ORDER_LOCK'::character varying, 'SHIPMENT_LOCK'::character varying])::text[])),
    amount     numeric                                not null
        constraint org_fees_amount_non_negative check (amount >= 0),
    created_at timestamp with time zone default now() not null,
    updated_at timestamp with time zone,
    primary key (org_id_fk, fee_type)
);

-- Append-only ledger of every change to a user's credit. `amount` is the signed
-- delta applied to the balance (negative = charge, positive = top-up/refund), so
-- new_balance = prev_balance + amount always holds. `order_id_fk` links a charge
-- to the order that triggered it (a future shipment_request flow will add its own
-- nullable reference the same way). Warehouse earnings for an org over a period =
-- -SUM(amount) WHERE entry_type IN ('ORDER_LOCK', 'SHIPMENT_LOCK').
create table credit_history
(
    id           uuid                        default gen_random_uuid() not null
        primary key,
    user_id_fk   uuid                                                  not null
        references users
            on update cascade on delete cascade,
    org_id_fk    uuid                                                  not null
        references organizations
            on update cascade on delete cascade,
    entry_type   varchar(50)                                           not null
        constraint credit_history_entry_type_check
            check ((entry_type)::text = ANY
                   ((ARRAY ['ORDER_LOCK'::character varying, 'SHIPMENT_LOCK'::character varying, 'TOP_UP'::character varying, 'ADJUSTMENT'::character varying])::text[])),
    amount       numeric                                               not null,
    prev_balance numeric                                               not null,
    new_balance  numeric                                               not null,
    order_id_fk  uuid
                                                                       references orders
                                                                           on update cascade on delete set null,
    -- Links a SHIPMENT_LOCK charge to the shipment that triggered it (the mirror
    -- of order_id_fk for the order-lock charge). Null for all other entry types.
    shipment_id_fk uuid
                                                                       references shipments
                                                                           on update cascade on delete set null,
    note         text,
    created_at   timestamp(3) with time zone default now()             not null
);

create index credit_history_user_created_idx
    on credit_history (user_id_fk, created_at desc, id desc);

create index credit_history_org_created_idx
    on credit_history (org_id_fk, created_at desc, id desc);

create index credit_history_order_id_idx
    on credit_history (order_id_fk);

create index credit_history_shipment_id_idx
    on credit_history (shipment_id_fk);

INSERT INTO wh.permissions (id, name, description, is_group_permission)
VALUES ('21646332-064e-42bf-9e62-aa2e86b94179', 'manage_organizations', 'Create organizations', false);
INSERT INTO wh.permissions (id, name, description, is_group_permission)
VALUES ('ea3dccf3-60be-4356-a726-eb36c4f95b6c', 'view_organizations', 'List and view organizations', false);
INSERT INTO wh.permissions (id, name, description, is_group_permission)
VALUES ('f791ba0f-83ca-4e43-b9cc-c9a1152faeec', 'manage_permissions', 'Create entries in the permission catalog',
        false);
INSERT INTO wh.permissions (id, name, description, is_group_permission)
VALUES ('27ff39fa-913c-4dc5-9e4f-d9d6b94c59ee', 'add_user', 'Create a user and attach them to an organization', true);
INSERT INTO wh.permissions (id, name, description, is_group_permission)
VALUES ('56538ced-125a-4f3d-aba3-31af58092eed', 'view_user_permissions', 'View a user''s effective permissions', true);
INSERT INTO wh.permissions (id, name, description, is_group_permission)
VALUES ('82d73bad-ea54-4bc4-b7ef-a50c29b7664f', 'manage_group_permissions', 'Grant or revoke a group permissions',
        true);
INSERT INTO wh.permissions (id, name, description, is_group_permission)
VALUES ('e648a875-828c-49ca-b5c0-35a4b7f9b237', 'manage_group_members', 'Assign or remove users from groups', true);
INSERT INTO wh.permissions (id, name, description, is_group_permission)
VALUES ('7832ba28-c7b3-4b9c-89dc-b33622c0c57e', 'view_org_members', 'List organization members', true);
INSERT INTO wh.permissions (id, name, description, is_group_permission)
VALUES ('bba79cb9-3d53-4104-a39d-aa68b94b2f59', 'manage_groups', 'Create or delete groups within an organization',
        true);
INSERT INTO wh.permissions (id, name, description, is_group_permission)
VALUES ('ddf8c440-82a4-4f2b-b150-24275bacaf7c', 'view_groups', 'List groups within an organization', true);
INSERT INTO wh.permissions (id, name, description, is_group_permission)
VALUES ('b31fec98-4ced-449d-9d87-f86b99bd77cd', 'manage_org_members', 'Add or remove organization members', true);
INSERT INTO wh.permissions (id, name, description, is_group_permission)
VALUES ('06b59256-0c3e-4628-b8ac-448d656b4b87', 'view_permissions', 'List the permission catalog', true);
INSERT INTO wh.permissions (id, name, description, is_group_permission)
VALUES ('ceca5a8f-c7f3-4968-ba3d-20b870e65c50', 'view_group_permissions', 'List a group''s permissions', true);
INSERT INTO wh.permissions (id, name, description, is_group_permission)
VALUES ('0165dd93-9c1e-4024-b4c3-5b952d5da5b7', 'place_order', 'Place orders into the warehouse', true);
INSERT INTO wh.permissions (id, name, description, is_group_permission)
VALUES ('edd30295-4d66-4c06-aaa8-b75c42975a68', 'manage_order', 'Manage orders: change status and quantity', true);
INSERT INTO wh.permissions (id, name, description, is_group_permission)
VALUES ('354632fd-3a28-4604-b85f-7863c93eee66', 'review_order', 'Review and lock orders, handing them to operations',
        true);
INSERT INTO wh.permissions (id, name, description, is_group_permission)
VALUES ('a1e6f2c4-0b7d-4d2a-9c3e-1f5b8a9d0c11', 'place_shipment', 'Request shipments against warehoused orders', true);
INSERT INTO wh.permissions (id, name, description, is_group_permission)
VALUES ('b2f7a3d5-1c8e-4e3b-8d4f-2a6c9b0e1d22', 'manage_shipment', 'Manage locked shipments: mark delivered or cancelled',
        true);
INSERT INTO wh.permissions (id, name, description, is_group_permission)
VALUES ('c3a8b4e6-2d9f-4f4c-9e5a-3b7d0c1f2e33', 'review_shipment',
        'Review and lock shipments, handing them to operations', true);
