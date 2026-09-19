-- Switch shipment_history to a structured JSON change log, mirroring order_history.
--
-- Replaces the typed diff columns (prev_status / new_status / prev_qty / new_qty) with a
-- single `changes` jsonb payload carrying the before/after detail, and swaps the coarse
-- change_type set (CREATED / STATUS_CHANGE / ITEM_CHANGE / LOCKED) for the structured
-- shipment kinds (CREATED / STATUS_CHANGED / LOCKED / ITEMS_CHANGED — one summary row per
-- line-set edit). Forward-only; idempotent where practical.

-- 1. Add the structured changes payload.
alter table wh.shipment_history
    add column if not exists changes jsonb;

-- 2. Migrate existing rows off the old typed columns, then drop them. Guarded on the
--    presence of prev_status so the whole block is skipped on a re-run (once the columns
--    are gone the remap/backfill would otherwise error).
do $$
begin
    if exists (select 1
                 from information_schema.columns
                where table_schema = 'wh'
                  and table_name = 'shipment_history'
                  and column_name = 'prev_status') then

        -- Remap the old change-type vocabulary onto the new set.
        update wh.shipment_history set change_type = 'STATUS_CHANGED' where change_type = 'STATUS_CHANGE';
        update wh.shipment_history set change_type = 'ITEMS_CHANGED'  where change_type = 'ITEM_CHANGE';

        -- Best-effort backfill of `changes` from the old columns for status-bearing rows
        -- (CREATED / STATUS_CHANGED). The old per-line rows only stored a summed total
        -- qty, which has no place in the new per-line shape, so those keep changes = null.
        update wh.shipment_history
           set changes = jsonb_build_object(
                   'shipment',
                   jsonb_strip_nulls(jsonb_build_object(
                       'status',
                       jsonb_strip_nulls(jsonb_build_object('from', prev_status, 'to', new_status)))))
         where changes is null
           and change_type in ('CREATED', 'STATUS_CHANGED')
           and (prev_status is not null or new_status is not null);

        alter table wh.shipment_history
            drop column prev_status,
            drop column new_status,
            drop column prev_qty,
            drop column new_qty;
    end if;
end $$;

-- 3. Replace the change_type CHECK with the granular set (mirror of order_history).
alter table wh.shipment_history
    drop constraint if exists shipment_history_change_type_check;

alter table wh.shipment_history
    add constraint shipment_history_change_type_check
        check (change_type = any (array ['CREATED'::varchar, 'STATUS_CHANGED'::varchar,
            'LOCKED'::varchar, 'ITEMS_CHANGED'::varchar]));
