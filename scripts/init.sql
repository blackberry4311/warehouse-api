create schema wh;

create table wh.users
(
    id            uuid                     default gen_random_uuid() not null
        primary key,
    email         varchar                                            not null,
    password_hash varchar                                            not null,
    display_name  varchar                                            not null,
    is_admin      boolean                  default false             not null,
    code          varchar(16),
    created_at    timestamp with time zone default now()             not null,
    updated_at    timestamp with time zone
);

create unique index user_unique on wh.users (email);
-- Per-user client code used to build human-readable order numbers (e.g. ACME-000123).
-- Nullable: only clients that place orders need one. NULLs are allowed to repeat.
create unique index user_code_unique on wh.users (code);

create table wh.refresh_tokens
(
    id         uuid                     default gen_random_uuid() not null
        primary key,
    user_id    uuid                                               not null
        references wh.users
            on update cascade on delete cascade,
    token_hash varchar                                            not null,
    user_agent varchar,
    ip_address varchar,
    expires_at timestamp with time zone                           not null,
    revoked_at timestamp with time zone,
    created_at timestamp with time zone default now()
);

create table wh.organizations
(
    id         uuid                     default gen_random_uuid() not null
        primary key,
    name       varchar(255)                                       not null,
    created_at timestamp with time zone default now()             not null,
    updated_at timestamp with time zone
);

create table wh.users_orgs
(
    user_id_fk uuid                                   not null
        references wh.users on update cascade on delete cascade,
    org_id_fk  uuid                                   not null
        references wh.organizations on update cascade on delete cascade,
    created_at timestamp with time zone default now() not null,
    primary key (user_id_fk, org_id_fk)
);

create index users_orgs_org_id_idx on wh.users_orgs (org_id_fk);

create table wh.org_groups
(
    id         uuid                     default gen_random_uuid() not null
        primary key,
    name       varchar(255)                                       not null,
    org_id_fk  uuid                                               not null
        references wh.organizations on update cascade on delete cascade,
    created_at timestamp with time zone default now()             not null,
    updated_at timestamp with time zone
);

create unique index org_group_unique on wh.org_groups (name, org_id_fk);
create index org_groups_org_id_idx on wh.org_groups (org_id_fk);

create table wh.permissions
(
    id           uuid primary key       not null default gen_random_uuid(),
    name         character varying(255) not null,
    description  text                   not null,
    is_group_lvl boolean                not null default false
);
create unique index permission_unique on wh.permissions using btree (name);

create unique index permission_unique on wh.permissions (name);

create table wh.user_groups
(
    user_id_fk  uuid                                   not null
        references wh.users on update cascade on delete cascade,
    group_id_fk uuid                                   not null
        references wh.org_groups on update cascade on delete cascade,
    created_at  timestamp with time zone default now() not null,
    primary key (user_id_fk, group_id_fk)
);

create index user_groups_group_id_idx on wh.user_groups (group_id_fk);

create table wh.group_permissions
(
    group_id_fk      uuid                                   not null
        references wh.org_groups on update cascade on delete cascade,
    permission_id_fk uuid                                   not null
        references wh.permissions on update cascade on delete cascade,
    created_at       timestamp with time zone default now() not null,
    primary key (group_id_fk, permission_id_fk)
);

create index group_permissions_permission_id_idx on wh.group_permissions (permission_id_fk);

INSERT INTO wh.permissions (description, name, is_group_lvl)
VALUES ('Create organizations', 'manage_organizations', false);
INSERT INTO wh.permissions (description, name, is_group_lvl)
VALUES ('List and view organizations', 'view_organizations', false);
INSERT INTO wh.permissions (description, name, is_group_lvl)
VALUES ('Create entries in the permission catalog', 'manage_permissions', false);
INSERT INTO wh.permissions (description, name, is_group_lvl)
VALUES ('Create a user and attach them to an organization', 'add_user', true);
INSERT INTO wh.permissions (description, name, is_group_lvl)
VALUES ('View a user''s effective permissions', 'view_user_permissions', true);
INSERT INTO wh.permissions (description, name, is_group_lvl)
VALUES ('Grant or revoke a group permissions', 'manage_group_permissions', true);
INSERT INTO wh.permissions (description, name, is_group_lvl)
VALUES ('Assign or remove users from groups', 'manage_group_members', true);
INSERT INTO wh.permissions (description, name, is_group_lvl)
VALUES ('List organization members', 'view_org_members', true);
INSERT INTO wh.permissions (description, name, is_group_lvl)
VALUES ('Create or delete groups within an organization', 'manage_groups', true);
INSERT INTO wh.permissions (description, name, is_group_lvl)
VALUES ('List groups within an organization', 'view_groups', true);
INSERT INTO wh.permissions (description, name, is_group_lvl)
VALUES ('Add or remove organization members', 'manage_org_members', true);
INSERT INTO wh.permissions (description, name, is_group_lvl)
VALUES ('List the permission catalog', 'view_permissions', true);
INSERT INTO wh.permissions (description, name, is_group_lvl)
VALUES ('List a group''s permissions', 'view_group_permissions', true);

-- Orders are scoped to an organization. A client (user_id_fk) places an order
-- within their org; the org's Operation group (manage_order) drives the status.
create table wh.orders
(
    id           uuid                        default gen_random_uuid() not null
        primary key,
    order_number varchar(255)                                          not null,
    org_id_fk    uuid                                                  not null
        references wh.organizations on update cascade on delete cascade,
    user_id_fk   uuid                                                  not null
        references wh.users on update cascade,
    qty          numeric                                               not null,
    status       varchar(50)                                           not null default 'PENDING'
        constraint orders_status_check
            check (status in ('PENDING', 'IN_WAREHOUSE', 'PROCESSING', 'COMPLETED', 'CANCELLED')),
    -- millisecond precision so the keyset-pagination cursor (a JS Date) round-trips exactly.
    created_at   timestamp(3) with time zone default now()             not null,
    updated_at   timestamp with time zone
);

-- order_number restarts per (user, org), so uniqueness is scoped to the org.
create unique index orders_number_unique on wh.orders (org_id_fk, order_number);
-- Composite keyset index: filter by org, page by (created_at desc, id desc).
create index orders_org_created_idx on wh.orders (org_id_fk, created_at desc, id desc);
create index orders_user_id_idx on wh.orders (user_id_fk);

-- Atomic per-(user, org) counter feeding order_number. Bumped inside the
-- place-order transaction via INSERT ... ON CONFLICT DO UPDATE ... RETURNING.
create table wh.order_sequences
(
    user_id_fk uuid   not null
        references wh.users on update cascade on delete cascade,
    org_id_fk  uuid   not null
        references wh.organizations on update cascade on delete cascade,
    next_seq   bigint not null default 0,
    primary key (user_id_fk, org_id_fk)
);

-- Append-only change log: one row per status/qty change (and a CREATED row on placement).
create table wh.order_history
(
    id            uuid                        default gen_random_uuid() not null
        primary key,
    order_id_fk   uuid                                                  not null
        references wh.orders on update cascade on delete cascade,
    changed_by_fk uuid                                                  not null
        references wh.users on update cascade,
    change_type   varchar(50)                                           not null
        constraint order_history_change_type_check
            check (change_type in ('CREATED', 'STATUS_CHANGE', 'QTY_CHANGE')),
    prev_status   varchar(50),
    new_status    varchar(50),
    prev_qty      numeric,
    new_qty       numeric,
    note          text,
    -- millisecond precision so the keyset-pagination cursor (a JS Date) round-trips exactly.
    created_at    timestamp(3) with time zone default now()             not null
);

-- Composite keyset index: filter by order, page by (created_at asc, id asc).
create index order_history_order_created_idx on wh.order_history (order_id_fk, created_at, id);

INSERT INTO wh.permissions (description, name, is_group_lvl)
VALUES ('Place orders into the warehouse', 'place_order', true);
INSERT INTO wh.permissions (description, name, is_group_lvl)
VALUES ('Manage orders: change status and quantity', 'manage_order', true);
