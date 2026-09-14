-- Rename the SHIPMENT_REQUEST fee/ledger value to SHIPMENT_LOCK so it mirrors
-- ORDER_LOCK: the charge happens when a reviewer LOCKS a shipment, not when it is
-- requested. Affects the org_fees.fee_type and credit_history.entry_type CHECK
-- constraints and any existing rows holding the old value.
--
-- Apply once against a database created from an older init.sql. Idempotent-ish:
-- safe to re-run (the UPDATEs match nothing the second time; the constraint
-- drop/add is unconditional). Run inside the wh schema.
--
--   psql "$DATABASE_URL" -f scripts/migrations/2026-09-14-rename-shipment-request-to-shipment-lock.sql

begin;

set local search_path to wh;

-- 1. Drop the old CHECK constraints (which only permit SHIPMENT_REQUEST), so the
--    value UPDATE below doesn't violate them.
alter table org_fees       drop constraint if exists org_fees_fee_type_check;
alter table credit_history drop constraint if exists credit_history_entry_type_check;

-- 2. Migrate existing data to the new value.
update org_fees       set fee_type   = 'SHIPMENT_LOCK' where fee_type   = 'SHIPMENT_REQUEST';
update credit_history set entry_type = 'SHIPMENT_LOCK' where entry_type = 'SHIPMENT_REQUEST';

-- 3. Re-add the CHECK constraints with the new allowed value set (matching init.sql).
alter table org_fees
    add constraint org_fees_fee_type_check
        check ((fee_type)::text = ANY
               ((ARRAY ['ORDER_LOCK'::character varying, 'SHIPMENT_LOCK'::character varying])::text[]));

alter table credit_history
    add constraint credit_history_entry_type_check
        check ((entry_type)::text = ANY
               ((ARRAY ['ORDER_LOCK'::character varying, 'SHIPMENT_LOCK'::character varying,
                        'TOP_UP'::character varying, 'ADJUSTMENT'::character varying])::text[]));

commit;
