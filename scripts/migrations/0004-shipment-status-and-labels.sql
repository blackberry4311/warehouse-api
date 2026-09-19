-- Shipment status rename (AWAITING / DONE / CANCELLED), drop the free-text tracking
-- field, and add a shipment shipping-label image table (mirror of credit_resources).
--
-- The label is the printable shipping label the client attaches and the warehouse
-- prints; it replaces the old `tracking` reference. Labels are cleaned up once their
-- shipment is DONE/CANCELLED (a daily cron), so — unlike bills — there is no age TTL.

-- 1. Rename the shipment status values. REQUESTED -> AWAITING, DELIVERED -> DONE.
--    Migrate existing rows first, then move the default and tighten the CHECK.
update wh.shipments set status = 'AWAITING' where status = 'REQUESTED';
update wh.shipments set status = 'DONE'     where status = 'DELIVERED';

-- Audit history keeps status strings in prev/new columns (no CHECK on them) — rename
-- for consistency so the trail reads in the new vocabulary.
update wh.shipment_history set prev_status = 'AWAITING' where prev_status = 'REQUESTED';
update wh.shipment_history set new_status  = 'AWAITING' where new_status  = 'REQUESTED';
update wh.shipment_history set prev_status = 'DONE'     where prev_status = 'DELIVERED';
update wh.shipment_history set new_status  = 'DONE'     where new_status  = 'DELIVERED';

alter table wh.shipments
    alter column status set default 'AWAITING';

alter table wh.shipments
    drop constraint if exists shipments_status_check;

alter table wh.shipments
    add constraint shipments_status_check
        check (status = any (array ['AWAITING'::varchar, 'DONE'::varchar, 'CANCELLED'::varchar]));

-- 2. Drop the free-text tracking field — replaced by the label image below.
alter table wh.shipments
    drop column if exists tracking;

-- 3. Shipping-label image, one per shipment. Same shape/logic as credit_resources:
--    bytes live in object storage, this row points at the object (object_key).
create table if not exists wh.shipment_labels (
    id             uuid                        default gen_random_uuid() not null
        primary key,
    shipment_id_fk uuid                                                  not null
        references wh.shipments
            on update cascade on delete cascade,
    object_key     varchar(512)                                          not null,
    content_type   varchar(128),
    size           bigint,
    created_at     timestamp(3) with time zone default now()             not null
);

-- One label per shipment.
create unique index if not exists shipment_labels_shipment_unique
    on wh.shipment_labels (shipment_id_fk);
