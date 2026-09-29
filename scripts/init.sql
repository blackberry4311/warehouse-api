create table users
(
    id            uuid                        default gen_random_uuid() not null
        primary key,
    email         varchar                                               not null,
    password_hash varchar                                               not null,
    display_name  varchar                                               not null,
    is_admin      boolean                     default false             not null,
    created_at    timestamp(3) with time zone default now()             not null,
    updated_at    timestamp with time zone,
    code          varchar(16),
    credit        numeric                     default 0                 not null
);

alter table users
    owner to postgres;

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

alter table refresh_tokens
    owner to postgres;

create table organizations
(
    id         uuid                     default gen_random_uuid() not null
        primary key,
    name       varchar(255)                                       not null,
    created_at timestamp with time zone default now()             not null,
    updated_at timestamp with time zone
);

alter table organizations
    owner to postgres;

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

alter table users_orgs
    owner to postgres;

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

alter table org_groups
    owner to postgres;

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
    is_group_permission boolean default false             not null,
    category            varchar(32)                       not null
        constraint permissions_category_check
            check ((category)::text = ANY
                   ((ARRAY ['order'::character varying, 'shipment'::character varying, 'organization'::character varying, 'access_control'::character varying])::text[]))
);

alter table permissions
    owner to postgres;

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

alter table user_groups
    owner to postgres;

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

alter table group_permissions
    owner to postgres;

create index group_permissions_permission_id_idx
    on group_permissions (permission_id_fk);

create table orders
(
    id           uuid                        default gen_random_uuid()               not null
        primary key,
    order_number varchar(255)                                                        not null,
    org_id_fk    uuid                                                                not null
        references organizations
            on update cascade on delete cascade,
    user_id_fk   uuid                                                                not null
        references users
            on update cascade,
    status       varchar(50)                 default 'IN_TRANSIT'::character varying not null
        constraint orders_status_check
            check ((status)::text = ANY
                   ((ARRAY ['IN_TRANSIT'::character varying, 'IN_WAREHOUSE'::character varying, 'CANCELLED'::character varying])::text[])),
    locked       boolean                     default false                           not null,
    created_at   timestamp(3) with time zone default now()                           not null,
    updated_at   timestamp with time zone,
    tracking     text                                                                not null
);

alter table orders
    owner to postgres;

create index orders_org_created_idx
    on orders (org_id_fk asc, created_at desc, id desc);

create index orders_org_locked_created_idx
    on orders (org_id_fk asc, locked asc, created_at desc, id desc);

create index orders_user_id_idx
    on orders (user_id_fk);

create unique index orders_org_number_unique
    on orders (org_id_fk, order_number);

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

alter table order_sequences
    owner to postgres;

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
                   ((ARRAY ['CREATED'::character varying, 'ORDER_UPDATED'::character varying, 'STATUS_CHANGED'::character varying, 'LOCKED'::character varying, 'ITEM_ADDED'::character varying, 'ITEM_UPDATED'::character varying, 'ITEM_REMOVED'::character varying, 'ITEM_RECEIPT'::character varying])::text[])),
    note          text,
    created_at    timestamp(3) with time zone default now()             not null,
    changes       jsonb
);

alter table order_history
    owner to postgres;

create index order_history_order_created_idx
    on order_history (order_id_fk, created_at, id);

create table org_fees
(
    org_id_fk  uuid                                   not null
        references organizations
            on update cascade on delete cascade,
    fee_type   varchar(50)                            not null
        constraint org_fees_fee_type_check
            check ((fee_type)::text = ANY
                   (ARRAY [('ORDER_LOCK'::character varying)::text, ('SHIPMENT_LOCK'::character varying)::text])),
    amount     numeric                                not null
        constraint org_fees_amount_non_negative
            check (amount >= (0)::numeric),
    created_at timestamp with time zone default now() not null,
    updated_at timestamp with time zone,
    primary key (org_id_fk, fee_type)
);

alter table org_fees
    owner to postgres;

create table shipments
(
    id              uuid                        default gen_random_uuid()             not null
        primary key,
    shipment_number varchar(255)                                                      not null,
    org_id_fk       uuid                                                              not null
        references organizations
            on update cascade on delete cascade,
    user_id_fk      uuid                                                              not null
        references users
            on update cascade,
    status          varchar(50)                 default 'AWAITING'::character varying not null
        constraint shipments_status_check
            check ((status)::text = ANY
                   ((ARRAY ['AWAITING'::character varying, 'DONE'::character varying, 'CANCELLED'::character varying])::text[])),
    locked          boolean                     default false                         not null,
    created_at      timestamp(3) with time zone default now()                         not null,
    updated_at      timestamp with time zone
);

alter table shipments
    owner to postgres;

create index shipments_org_created_idx
    on shipments (org_id_fk asc, created_at desc, id desc);

create index shipments_org_locked_created_idx
    on shipments (org_id_fk asc, locked asc, created_at desc, id desc);

create index shipments_user_id_idx
    on shipments (user_id_fk);

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
                   ((ARRAY ['CREATED'::character varying, 'STATUS_CHANGED'::character varying, 'LOCKED'::character varying, 'ITEMS_CHANGED'::character varying])::text[])),
    note           text,
    created_at     timestamp(3) with time zone default now()             not null,
    changes        jsonb
);

alter table shipment_history
    owner to postgres;

create index shipment_history_shipment_created_idx
    on shipment_history (shipment_id_fk, created_at, id);

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

alter table shipment_sequences
    owner to postgres;

create table total_fees
(
    id             uuid                        default gen_random_uuid() not null
        constraint extra_fees_pkey
            primary key,
    name           varchar(200)                                          not null,
    amount         numeric                                               not null
        constraint total_fees_amount_check
            check (amount >= (0)::numeric),
    org_id_fk      uuid                                                  not null
        constraint extra_fees_org_id_fk_fkey
            references organizations
            on update cascade on delete cascade,
    order_id_fk    uuid
        constraint extra_fees_order_id_fk_fkey
            references orders
            on update cascade on delete cascade,
    shipment_id_fk uuid
        constraint extra_fees_shipment_id_fk_fkey
            references shipments
            on update cascade on delete cascade,
    created_by_fk  uuid                                                  not null
        constraint extra_fees_created_by_fk_fkey
            references users
            on update cascade,
    note           text,
    voided_at      timestamp(3) with time zone,
    voided_by_fk   uuid
        constraint extra_fees_voided_by_fk_fkey
            references users
            on update cascade,
    created_at     timestamp(3) with time zone default now()             not null,
    is_protected   boolean                     default false             not null,
    constraint extra_fees_one_target
        check ((order_id_fk IS NOT NULL) <> (shipment_id_fk IS NOT NULL))
);

alter table total_fees
    owner to postgres;

create table credit_history
(
    id             uuid                        default gen_random_uuid() not null
        primary key,
    user_id_fk     uuid                                                  not null
        references users
            on update cascade on delete cascade,
    org_id_fk      uuid                                                  not null
        references organizations
            on update cascade on delete cascade,
    entry_type     varchar(50)                                           not null
        constraint credit_history_entry_type_check
            check ((entry_type)::text = ANY
                   (ARRAY [('ORDER_LOCK'::character varying)::text, ('SHIPMENT_LOCK'::character varying)::text, ('EXTRA_FEE'::character varying)::text, ('TOP_UP'::character varying)::text, ('ADJUSTMENT'::character varying)::text, ('RESELLER_COMMISSION'::character varying)::text])),
    amount         numeric                                               not null,
    prev_balance   numeric                                               not null,
    new_balance    numeric                                               not null,
    order_id_fk    uuid
                                                                         references orders
                                                                             on update cascade on delete set null,
    note           text,
    created_at     timestamp(3) with time zone default now()             not null,
    shipment_id_fk uuid
                                                                         references shipments
                                                                             on update cascade on delete set null,
    fee_id_fk      uuid
        constraint credit_history_extra_fee_id_fk_fkey
            references total_fees
            on update cascade on delete set null
);

alter table credit_history
    owner to postgres;

create index credit_history_fee_id_idx
    on credit_history (fee_id_fk);

create index credit_history_user_created_idx
    on credit_history (user_id_fk asc, created_at desc, id desc);

create index credit_history_user_org_created_idx
    on credit_history (user_id_fk asc, org_id_fk asc, created_at desc, id desc);

create index credit_history_org_created_idx
    on credit_history (org_id_fk asc, created_at desc, id desc);

create index total_fees_order_created_idx
    on total_fees (order_id_fk asc, created_at desc, id desc);

create index total_fees_shipment_created_idx
    on total_fees (shipment_id_fk asc, created_at desc, id desc);

create table order_details
(
    id          uuid                        default gen_random_uuid()            not null
        primary key,
    order_id_fk uuid                                                             not null
        references orders
            on update cascade on delete cascade,
    name        varchar(255)                                                     not null,
    qty         numeric                                                          not null,
    note        text,
    status      varchar(50)                 default 'PENDING'::character varying not null
        constraint order_details_status_check
            check ((status)::text = ANY
                   ((ARRAY ['PENDING'::character varying, 'RECEIVED'::character varying, 'NOT_ARRIVED'::character varying, 'CANCELLED'::character varying])::text[])),
    created_at  timestamp(3) with time zone default now()                        not null,
    shipped_qty numeric                     default 0                            not null
);

alter table order_details
    owner to postgres;

create table shipment_details
(
    shipment_id_fk     uuid    not null
        references shipments
            on update cascade on delete cascade,
    qty                numeric not null,
    order_detail_id_fk uuid    not null
        constraint shipment_details_order_detail_fk
            references order_details
            on update cascade on delete cascade,
    primary key (shipment_id_fk, order_detail_id_fk)
);

alter table shipment_details
    owner to postgres;

create index shipment_details_order_detail_id_idx
    on shipment_details (order_detail_id_fk);

create index order_details_order_idx
    on order_details (order_id_fk);

create table credit_resources
(
    id           uuid                        default gen_random_uuid() not null
        primary key,
    credit_id_fk uuid                                                  not null
        references credit_history
            on update cascade on delete cascade,
    object_key   varchar(512)                                          not null,
    content_type varchar(128),
    size         bigint,
    created_at   timestamp(3) with time zone default now()             not null
);

alter table credit_resources
    owner to postgres;

create unique index credit_resources_credit_unique
    on credit_resources (credit_id_fk);

create index credit_resources_created_idx
    on credit_resources (created_at);

create table shipment_labels
(
    id             uuid                        default gen_random_uuid() not null
        primary key,
    shipment_id_fk uuid                                                  not null
        references shipments
            on update cascade on delete cascade,
    object_key     varchar(512)                                          not null,
    content_type   varchar(128),
    size           bigint,
    created_at     timestamp(3) with time zone default now()             not null
);

alter table shipment_labels
    owner to postgres;

create unique index shipment_labels_shipment_unique
    on shipment_labels (shipment_id_fk);

create table credit_groups
(
    id          uuid                        default gen_random_uuid() not null
        primary key,
    name        varchar(255)                                          not null,
    org_id_fk   uuid                                                  not null
        references organizations
            on update cascade on delete cascade,
    owner_id_fk uuid                                                  not null
        references users
            on update cascade on delete cascade,
    created_at  timestamp(3) with time zone default now()             not null,
    updated_at  timestamp with time zone
);

alter table credit_groups
    owner to postgres;

create unique index credit_groups_org_name_unique
    on credit_groups (org_id_fk, name);

create index credit_groups_org_idx
    on credit_groups (org_id_fk);

create index credit_groups_owner_idx
    on credit_groups (owner_id_fk);

create table credit_group_fees
(
    credit_group_id_fk uuid        not null
        references credit_groups
            on update cascade on delete cascade,
    fee_type           varchar(50) not null
        constraint credit_group_fees_fee_type_check
            check ((fee_type)::text = ANY
                   (ARRAY [('ORDER_LOCK'::character varying)::text, ('SHIPMENT_LOCK'::character varying)::text])),
    amount             numeric     not null
        constraint credit_group_fees_amount_non_negative
            check (amount >= (0)::numeric),
    updated_at         timestamp with time zone,
    primary key (credit_group_id_fk, fee_type)
);

alter table credit_group_fees
    owner to postgres;

create table credit_group_members
(
    credit_group_id_fk uuid                                      not null
        references credit_groups
            on update cascade on delete cascade,
    user_id_fk         uuid                                      not null
        references users
            on update cascade on delete cascade,
    org_id_fk          uuid                                      not null
        references organizations
            on update cascade on delete cascade,
    created_at         timestamp(3) with time zone default now() not null,
    primary key (credit_group_id_fk, user_id_fk)
);

alter table credit_group_members
    owner to postgres;

create unique index credit_group_members_user_org_unique
    on credit_group_members (user_id_fk, org_id_fk);

create index credit_group_members_group_idx
    on credit_group_members (credit_group_id_fk);

create table activity_log
(
    id                 uuid                        default gen_random_uuid() not null
        primary key,
    org_id_fk          uuid
        references organizations
            on update cascade on delete cascade,
    actor_id_fk        uuid
                                                                             references users
                                                                                 on update cascade on delete set null,
    subject_user_id_fk uuid
                                                                             references users
                                                                                 on update cascade on delete set null,
    entity_type        varchar(30)                                           not null
        constraint activity_log_entity_type_check
            check ((entity_type)::text = ANY
                   ((ARRAY ['ORDER'::character varying, 'SHIPMENT'::character varying, 'CREDIT'::character varying])::text[])),
    entity_id          uuid                                                  not null,
    action             varchar(50)                                           not null,
    summary            jsonb,
    created_at         timestamp(3) with time zone default now()             not null,
    notified_at        timestamp(3) with time zone
);

alter table activity_log
    owner to postgres;

create index activity_log_org_created_idx
    on activity_log (org_id_fk asc, created_at desc, id desc);

create index activity_log_actor_created_idx
    on activity_log (actor_id_fk asc, created_at desc, id desc);

create index activity_log_subject_created_idx
    on activity_log (subject_user_id_fk asc, created_at desc, id desc);

create index activity_log_pending_notify_idx
    on activity_log (created_at)
    where (notified_at IS NULL);

create table notifications
(
    id              uuid                        default gen_random_uuid() not null
        primary key,
    recipient_id_fk uuid                                                  not null
        references users
            on update cascade on delete cascade,
    activity_id_fk  uuid                                                  not null
        references activity_log
            on update cascade on delete cascade,
    read_at         timestamp(3) with time zone,
    created_at      timestamp(3) with time zone default now()             not null
);

alter table notifications
    owner to postgres;

create unique index notifications_recipient_activity_unique
    on notifications (recipient_id_fk, activity_id_fk);

create index notifications_recipient_created_idx
    on notifications (recipient_id_fk asc, created_at desc, id desc);

create index notifications_recipient_unread_idx
    on notifications (recipient_id_fk)
    where (read_at IS NULL);

create index notifications_activity_idx
    on notifications (activity_id_fk);

INSERT INTO wh.users (id, email, password_hash, display_name, is_admin, created_at, updated_at, code, credit)
VALUES ('0ccead85-d5c4-487b-9777-8aac535de9d8', 'sytoanit@gmail.com',
        '$2b$10$o.UtdrYRhhVGCIvbi2QzqOnL0Kdk1.r3ktbbtbthKMF3.EosUXBl2', 'black', true, '2026-07-20 15:50:06.281 +00:00',
        '2026-09-08 02:51:23.952535 +00:00', 'BLACK', 0);
INSERT INTO wh.users (id, email, password_hash, display_name, is_admin, created_at, updated_at, code, credit)
VALUES ('232c803a-8234-4781-9434-8ab2117b4629', 'hungnguyenhnvn@yahoo.com',
        '$2b$10$vZaXwA3h9NN1aXNDsQcKheHzgGZzbxwbqY16/OUArjCOTNh6YucXC', 'SepHung', false,
        '2026-09-14 13:39:35.639 +00:00', null, 'SEPHUNG', 0);

INSERT INTO wh.permissions (id, name, description, is_group_permission, category)
VALUES ('21646332-064e-42bf-9e62-aa2e86b94179', 'manage_organizations', 'Create organizations', false, 'organization');
INSERT INTO wh.permissions (id, name, description, is_group_permission, category)
VALUES ('ea3dccf3-60be-4356-a726-eb36c4f95b6c', 'view_organizations', 'List and view organizations', false,
        'organization');
INSERT INTO wh.permissions (id, name, description, is_group_permission, category)
VALUES ('27ff39fa-913c-4dc5-9e4f-d9d6b94c59ee', 'add_user', 'Create a user and attach them to an organization', true,
        'organization');
INSERT INTO wh.permissions (id, name, description, is_group_permission, category)
VALUES ('7832ba28-c7b3-4b9c-89dc-b33622c0c57e', 'view_org_members', 'List organization members', true, 'organization');
INSERT INTO wh.permissions (id, name, description, is_group_permission, category)
VALUES ('bba79cb9-3d53-4104-a39d-aa68b94b2f59', 'manage_groups', 'Create or delete groups within an organization', true,
        'organization');
INSERT INTO wh.permissions (id, name, description, is_group_permission, category)
VALUES ('ddf8c440-82a4-4f2b-b150-24275bacaf7c', 'view_groups', 'List groups within an organization', true,
        'organization');
INSERT INTO wh.permissions (id, name, description, is_group_permission, category)
VALUES ('b31fec98-4ced-449d-9d87-f86b99bd77cd', 'manage_org_members', 'Add or remove organization members', true,
        'organization');
INSERT INTO wh.permissions (id, name, description, is_group_permission, category)
VALUES ('f791ba0f-83ca-4e43-b9cc-c9a1152faeec', 'manage_permissions', 'Create entries in the permission catalog', false,
        'access_control');
INSERT INTO wh.permissions (id, name, description, is_group_permission, category)
VALUES ('56538ced-125a-4f3d-aba3-31af58092eed', 'view_user_permissions', 'View a user''s effective permissions', true,
        'access_control');
INSERT INTO wh.permissions (id, name, description, is_group_permission, category)
VALUES ('82d73bad-ea54-4bc4-b7ef-a50c29b7664f', 'manage_group_permissions', 'Grant or revoke a group permissions', true,
        'access_control');
INSERT INTO wh.permissions (id, name, description, is_group_permission, category)
VALUES ('e648a875-828c-49ca-b5c0-35a4b7f9b237', 'manage_group_members', 'Assign or remove users from groups', true,
        'access_control');
INSERT INTO wh.permissions (id, name, description, is_group_permission, category)
VALUES ('06b59256-0c3e-4628-b8ac-448d656b4b87', 'view_permissions', 'List the permission catalog', true,
        'access_control');
INSERT INTO wh.permissions (id, name, description, is_group_permission, category)
VALUES ('ceca5a8f-c7f3-4968-ba3d-20b870e65c50', 'view_group_permissions', 'List a group''s permissions', true,
        'access_control');
INSERT INTO wh.permissions (id, name, description, is_group_permission, category)
VALUES ('0165dd93-9c1e-4024-b4c3-5b952d5da5b7', 'place_order', 'Place orders into the warehouse', true, 'order');
INSERT INTO wh.permissions (id, name, description, is_group_permission, category)
VALUES ('354632fd-3a28-4604-b85f-7863c93eee66', 'review_order', 'Review and lock orders, handing them to operations',
        true, 'order');
INSERT INTO wh.permissions (id, name, description, is_group_permission, category)
VALUES ('a1e6f2c4-0b7d-4d2a-9c3e-1f5b8a9d0c11', 'place_shipment', 'Request shipments against warehoused orders', true,
        'shipment');
INSERT INTO wh.permissions (id, name, description, is_group_permission, category)
VALUES ('c3a8b4e6-2d9f-4f4c-9e5a-3b7d0c1f2e33', 'review_shipment',
        'Review and lock shipments, handing them to operations', true, 'shipment');
INSERT INTO wh.permissions (id, name, description, is_group_permission, category)
VALUES ('554f7c36-6b6a-4748-a6c8-75a63ba470c2', 'manage_all_users',
        'List all users in the system and assign them to organizations', true, 'access_control');
INSERT INTO wh.permissions (id, name, description, is_group_permission, category)
VALUES ('edd30295-4d66-4c06-aaa8-b75c42975a68', 'process_order',
        'Process orders: drive the warehouse lifecycle (count, record detail, move goods in/out)', true, 'order');
INSERT INTO wh.permissions (id, name, description, is_group_permission, category)
VALUES ('b2f7a3d5-1c8e-4e3b-8d4f-2a6c9b0e1d22', 'process_shipment',
        'Process locked shipments: move goods out and mark delivered or cancelled', true, 'shipment');
INSERT INTO wh.permissions (id, name, description, is_group_permission, category)
VALUES ('7d2549e7-86ca-456d-90c8-f257b6f0b35e', 'view_user_balances', 'View member wallet balances and credit history',
        true, 'organization');
INSERT INTO wh.permissions (id, name, description, is_group_permission, category)
VALUES ('53d91170-da2d-4bac-84ad-9f3317bc4076', 'manage_user_balances', 'Top up member wallets and manage top-up bills',
        true, 'organization');
INSERT INTO wh.permissions (id, name, description, is_group_permission, category)
VALUES ('e25e0032-310f-4334-85f6-476442d5d991', 'view_all_activity_log', 'View the full org activity log (all users)',
        true, 'organization');
