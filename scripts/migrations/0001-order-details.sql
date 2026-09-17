-- Phase 1: order line items (order_details) + order-status simplification +
-- structured order_history change log + per-org order_number uniqueness.
--
-- Quantity moves from the order header onto per-line order_details; the order
-- status set is reduced to IN_TRANSIT / IN_WAREHOUSE / CANCELLED. The shipment
-- module is deliberately untouched (phase 2), so orders.qty / orders.shipped_qty and
-- the COMPLETED status are retained as shipment-only legacy.
--
-- NOTE: existing orders in SHIPPING/ARRIVING would violate the new status CHECK.
-- This is a development-phase change; clean up / migrate such rows before applying.

-- 1. Order line items. name = client code + free text; qty lives here now.
create table if not exists wh.order_details (
    id          uuid                        default gen_random_uuid() not null
        primary key,
    order_id_fk uuid                                                  not null
        references wh.orders
            on update cascade on delete cascade,
    name        varchar(255)                                          not null,
    qty         numeric                                               not null,
    note        text,
    status      varchar(50)                 default 'PENDING'         not null
        constraint order_details_status_check
            check (status = any (array ['PENDING'::varchar, 'RECEIVED'::varchar,
                'NOT_ARRIVED'::varchar, 'CANCELLED'::varchar])),
    created_at  timestamp(3) with time zone default now()             not null
);

create index if not exists order_details_order_idx
    on wh.order_details (order_id_fk);

-- 2. Drop orders.qty — quantity now lives per-line on order_details. (orders.shipped_qty
--    is kept as shipment-only legacy until phase 2 repoints shipments at the lines.)
alter table wh.orders
    drop column if exists qty;

-- 3. Simplify the order status set. IN_TRANSIT replaces SHIPPING/ARRIVING as the
--    single initial state; COMPLETED is kept in the CHECK only because the shipment
--    module still sets it (phase 2 removes it).
alter table wh.orders
    alter column status set default 'IN_TRANSIT';

alter table wh.orders
    drop constraint if exists orders_status_check;

alter table wh.orders
    add constraint orders_status_check
        check (status = any (array ['IN_TRANSIT'::varchar, 'IN_WAREHOUSE'::varchar,
            'COMPLETED'::varchar, 'CANCELLED'::varchar]));

-- 4. order_history: switch to a structured JSON change log. Add a `changes` jsonb
--    payload (the before/after detail the FE shows), drop the old typed diff columns
--    (superseded by `changes`), and replace the change_type set with the granular
--    order-level / line-level kinds.
alter table wh.order_history
    add column if not exists changes jsonb;

alter table wh.order_history
    drop column if exists prev_status,
    drop column if exists new_status,
    drop column if exists prev_qty,
    drop column if exists new_qty;

alter table wh.order_history
    drop constraint if exists order_history_change_type_check;

alter table wh.order_history
    add constraint order_history_change_type_check
        check (change_type = any (array ['CREATED'::varchar, 'ORDER_UPDATED'::varchar,
            'STATUS_CHANGED'::varchar, 'LOCKED'::varchar, 'ITEM_ADDED'::varchar,
            'ITEM_UPDATED'::varchar, 'ITEM_REMOVED'::varchar, 'ITEM_RECEIPT'::varchar]));

-- 5. Enforce order_number uniqueness PER ORG. Guaranteed by construction (numbers are
--    auto-generated <code>-<seq>: users.code is globally unique and order_sequences is
--    bumped atomically per (user, org)) but never enforced in the schema until now.
--    Per-org, not global: the sequence restarts per org, so the same client legitimately
--    produces the same <code>-<seq> in two different orgs.
create unique index if not exists orders_org_number_unique
    on wh.orders (org_id_fk, order_number);
