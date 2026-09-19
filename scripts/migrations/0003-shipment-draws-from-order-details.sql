-- Phase 2: shipments draw from order LINE ITEMS, not the order header.
--
-- Inventory is per-line now, so shipped quantity moves onto order_details and the
-- shipment↔order junction is repointed at order_details. The order header stops being
-- touched by shipments at all: orders.shipped_qty is dropped and the deprecated
-- COMPLETED order status is removed from the CHECK.
--
-- NOTE: the shipment module was stubbed before this (no draw could ever succeed), so
-- shipment_details is guaranteed empty and no orders reached COMPLETED — nothing to
-- back-fill. The COMPLETED→IN_WAREHOUSE update below is a defensive no-op.

-- 1. Per-line shipped quantity (what a shipment now deducts). qty - shipped_qty is the
--    line's remaining inventory.
alter table wh.order_details
    add column if not exists shipped_qty numeric not null default 0;

-- 2. Repoint shipment_details from the order header (order_id_fk) onto the order line
--    item (order_detail_id_fk). The table is empty, so no data migration is needed.
alter table wh.shipment_details
    add column if not exists order_detail_id_fk uuid;

alter table wh.shipment_details
    drop constraint if exists shipment_details_pkey;

drop index if exists wh.shipment_details_order_id_idx;

alter table wh.shipment_details
    drop column if exists order_id_fk;

alter table wh.shipment_details
    alter column order_detail_id_fk set not null;

alter table wh.shipment_details
    drop constraint if exists shipment_details_order_detail_fk;

alter table wh.shipment_details
    add constraint shipment_details_order_detail_fk
        foreign key (order_detail_id_fk) references wh.order_details
            on update cascade on delete cascade;

alter table wh.shipment_details
    add constraint shipment_details_pkey
        primary key (shipment_id_fk, order_detail_id_fk);

create index if not exists shipment_details_order_detail_id_idx
    on wh.shipment_details (order_detail_id_fk);

-- 3. The order header is no longer touched by shipments: drop its shipped_qty counter.
alter table wh.orders
    drop column if exists shipped_qty;

-- 4. Remove the deprecated COMPLETED order status (shipment-only legacy, now gone).
--    Migrate any stragglers first so the tightened CHECK applies cleanly.
update wh.orders
    set status = 'IN_WAREHOUSE'
    where status = 'COMPLETED';

alter table wh.orders
    drop constraint if exists orders_status_check;

alter table wh.orders
    add constraint orders_status_check
        check (status = any (array ['IN_TRANSIT'::varchar, 'IN_WAREHOUSE'::varchar,
            'CANCELLED'::varchar]));
