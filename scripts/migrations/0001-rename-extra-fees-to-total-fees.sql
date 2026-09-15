-- 0001-rename-extra-fees-to-total-fees.sql
--
-- Fold the flat lock fee into the ad-hoc fee table so one table lists *every* fee
-- charged against an order/shipment:
--   * rename wh.extra_fees -> wh.total_fees (+ its indexes),
--   * add is_protected (true = the system lock fee, non-voidable; false = a
--     staff-added extra fee, voidable),
--   * relax the amount CHECK from (> 0) to (>= 0) so a zero lock fee can be recorded,
--   * rename credit_history.extra_fee_id_fk -> fee_id_fk (+ its index),
--   * backfill a protected lock-fee row for every already-locked order/shipment and
--     link the existing ORDER_LOCK / SHIPMENT_LOCK ledger rows to it.
--
-- Forward-only and idempotent. Apply by hand against the running DB (no runner).

-- 1. Rename the table (only if it hasn't been renamed already).
do $$
begin
  if exists (select 1 from information_schema.tables
             where table_schema = 'wh' and table_name = 'extra_fees')
     and not exists (select 1 from information_schema.tables
                     where table_schema = 'wh' and table_name = 'total_fees') then
    alter table wh.extra_fees rename to total_fees;
  end if;
end $$;

-- 2. Rename the table's indexes to match (cosmetic; not referenced by code).
alter index if exists wh.extra_fees_order_created_idx rename to total_fees_order_created_idx;
alter index if exists wh.extra_fees_shipment_created_idx rename to total_fees_shipment_created_idx;

-- 3. Add the protected flag. Extra fees default false; the lock fee sets it true.
alter table wh.total_fees add column if not exists is_protected boolean not null default false;

-- 4. Relax the amount CHECK to (>= 0). The original inline constraint's name is
--    auto-generated, so drop any amount CHECK by catalog and re-add the relaxed one.
do $$
declare con_name text;
begin
  for con_name in
    select con.conname
    from pg_constraint con
    join pg_class rel on rel.oid = con.conrelid
    join pg_namespace ns on ns.oid = rel.relnamespace
    where ns.nspname = 'wh' and rel.relname = 'total_fees' and con.contype = 'c'
      and pg_get_constraintdef(con.oid) ilike '%amount%'
  loop
    execute format('alter table wh.total_fees drop constraint %I', con_name);
  end loop;

  if not exists (
    select 1 from pg_constraint con
    join pg_class rel on rel.oid = con.conrelid
    join pg_namespace ns on ns.oid = rel.relnamespace
    where ns.nspname = 'wh' and rel.relname = 'total_fees'
      and con.conname = 'total_fees_amount_check'
  ) then
    alter table wh.total_fees add constraint total_fees_amount_check check (amount >= 0);
  end if;
end $$;

-- 5. Rename credit_history.extra_fee_id_fk -> fee_id_fk (the FK follows the column,
--    and the FK's target followed the table rename above). Also rename its index.
do $$
begin
  if exists (select 1 from information_schema.columns
             where table_schema = 'wh' and table_name = 'credit_history'
               and column_name = 'extra_fee_id_fk')
     and not exists (select 1 from information_schema.columns
                     where table_schema = 'wh' and table_name = 'credit_history'
                       and column_name = 'fee_id_fk') then
    alter table wh.credit_history rename column extra_fee_id_fk to fee_id_fk;
  end if;
end $$;

do $$
declare idx_name text;
begin
  for idx_name in
    select c.relname
    from pg_index idx
    join pg_class c on c.oid = idx.indexrelid
    join pg_class rel on rel.oid = idx.indrelid
    join pg_namespace ns on ns.oid = rel.relnamespace
    where ns.nspname = 'wh' and rel.relname = 'credit_history' and c.relname ilike '%extra_fee%'
  loop
    execute format('alter index wh.%I rename to %I', idx_name,
                   replace(idx_name, 'extra_fee', 'fee'));
  end loop;
end $$;

-- 6. Backfill: every already-locked order gets one protected lock-fee row. Amount is
--    what was actually charged (the ORDER_LOCK ledger row, if any; else 0 — a 0 fee
--    wrote no ledger row historically). created_by / created_at come from the LOCKED
--    history row (the reviewer who locked it), falling back to the client / now().
insert into wh.total_fees
  (id, name, amount, is_protected, org_id_fk, order_id_fk, shipment_id_fk,
   created_by_fk, note, created_at)
select
  gen_random_uuid(),
  'Order lock fee',
  coalesce(charge.charged, 0),
  true,
  o.org_id_fk,
  o.id,
  null,
  coalesce(locker.changed_by_fk, o.user_id_fk),
  null,
  coalesce(locker.locked_at, now())
from wh.orders o
left join lateral (
  select oh.changed_by_fk, oh.created_at as locked_at
  from wh.order_history oh
  where oh.order_id_fk = o.id and oh.change_type = 'LOCKED'
  order by oh.created_at asc
  limit 1
) locker on true
left join lateral (
  select -ch.amount as charged
  from wh.credit_history ch
  where ch.order_id_fk = o.id and ch.entry_type = 'ORDER_LOCK'
  order by ch.created_at asc
  limit 1
) charge on true
where o.locked = true
  and not exists (
    select 1 from wh.total_fees tf
    where tf.order_id_fk = o.id and tf.is_protected = true
  );

-- Same for shipments.
insert into wh.total_fees
  (id, name, amount, is_protected, org_id_fk, order_id_fk, shipment_id_fk,
   created_by_fk, note, created_at)
select
  gen_random_uuid(),
  'Shipment lock fee',
  coalesce(charge.charged, 0),
  true,
  s.org_id_fk,
  null,
  s.id,
  coalesce(locker.changed_by_fk, s.user_id_fk),
  null,
  coalesce(locker.locked_at, now())
from wh.shipments s
left join lateral (
  select sh.changed_by_fk, sh.created_at as locked_at
  from wh.shipment_history sh
  where sh.shipment_id_fk = s.id and sh.change_type = 'LOCKED'
  order by sh.created_at asc
  limit 1
) locker on true
left join lateral (
  select -ch.amount as charged
  from wh.credit_history ch
  where ch.shipment_id_fk = s.id and ch.entry_type = 'SHIPMENT_LOCK'
  order by ch.created_at asc
  limit 1
) charge on true
where s.locked = true
  and not exists (
    select 1 from wh.total_fees tf
    where tf.shipment_id_fk = s.id and tf.is_protected = true
  );

-- 7. Link the existing lock-fee ledger rows to the backfilled fee rows.
update wh.credit_history ch
set fee_id_fk = tf.id
from wh.total_fees tf
where tf.is_protected = true
  and tf.order_id_fk = ch.order_id_fk
  and ch.entry_type = 'ORDER_LOCK'
  and ch.fee_id_fk is null;

update wh.credit_history ch
set fee_id_fk = tf.id
from wh.total_fees tf
where tf.is_protected = true
  and tf.shipment_id_fk = ch.shipment_id_fk
  and ch.entry_type = 'SHIPMENT_LOCK'
  and ch.fee_id_fk is null;
