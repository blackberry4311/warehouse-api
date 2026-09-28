-- One-off backfill of wh.activity_log from the existing per-entity logs, so the
-- activity page shows the history recorded before the feed existed. Each source row
-- maps to the activity row the live code (recordActivity) would have written:
--
--   order_history     → ORDER_PLACED / ORDER_UPDATED / ORDER_STATUS_CHANGED /
--                       ORDER_LOCKED / ORDER_ITEM_ADDED|UPDATED|REMOVED|RECEIPT
--   shipment_history  → SHIPMENT_PLACED / SHIPMENT_ITEMS_CHANGED / SHIPMENT_LOCKED /
--                       SHIPMENT_STATUS_CHANGED
--   credit_history    → EXTRA_FEE          → ORDER|SHIPMENT_FEE_ADDED (amount < 0)
--                                            / _FEE_VOIDED (amount > 0)
--                       TOP_UP / ADJUSTMENT → CREDIT_TOPPED_UP / CREDIT_ADJUSTED
--                       RESELLER_COMMISSION → CREDIT_COMMISSION
--                       (ORDER_LOCK / SHIPMENT_LOCK are folded into the *_LOCKED row's
--                       fee / prevBalance / newBalance, as the live code does)
--   shipment_labels   → SHIPMENT_LABEL_SET (the current label only; removals and
--                       earlier replaced uploads were never recorded)
--
-- Known gaps in what the old data can tell us:
--   - TOP_UP / ADJUSTMENT rows have no actor (credit_history never stored who made
--     them), so actor_id_fk is NULL.
--   - Auto-receipts (lines flipped to RECEIVED when an order moved to IN_WAREHOUSE) are
--     recognised by sharing the status change's transaction timestamp and folded into
--     its `autoReceived` count, like the live code.
--   - A voided fee's note is the ledger note (defaults to 'Void of fee "…"').
--   - Rows from before 0001/0005 may have `changes = null`; their diff keys are omitted.
--
-- Idempotent: each activity row reuses its source row's id (ON CONFLICT DO NOTHING),
-- and a source row is skipped when the live code already logged the same action for
-- the same record in the same transaction (identical created_at), so re-running this,
-- or running it after the new code has been live, never duplicates.

BEGIN;

-- Drop top-level null keys only (jsonb_strip_nulls is recursive and would also drop
-- the `from: null` / `to: null` inside diffs). Session-local; gone after disconnect.
CREATE OR REPLACE FUNCTION pg_temp.strip_top_nulls(j jsonb) RETURNS jsonb
    LANGUAGE sql IMMUTABLE AS
$$
SELECT coalesce(jsonb_object_agg(key, value) FILTER (WHERE value <> 'null'::jsonb), '{}'::jsonb)
FROM jsonb_each(j)
$$;

-- 1. order_history -----------------------------------------------------------------
INSERT INTO wh.activity_log (id, org_id_fk, actor_id_fk, subject_user_id_fk, entity_type,
                             entity_id, action, summary, created_at)
SELECT h.id,
       o.org_id_fk,
       h.changed_by_fk,
       o.user_id_fk,
       'ORDER',
       o.id,
       m.action,
       pg_temp.strip_top_nulls(
               jsonb_build_object('orderNumber', o.order_number, 'note', h.note) || m.extra),
       h.created_at
FROM wh.order_history h
         JOIN wh.orders o ON o.id = h.order_id_fk
         LEFT JOIN LATERAL (
    SELECT c.prev_balance, c.new_balance
    FROM wh.credit_history c
    WHERE h.change_type = 'LOCKED'
      AND c.order_id_fk = o.id
      AND c.entry_type = 'ORDER_LOCK'
    ORDER BY c.created_at
    LIMIT 1
    ) lc ON true
         CROSS JOIN LATERAL (
    SELECT CASE h.change_type
               WHEN 'CREATED' THEN 'ORDER_PLACED'
               WHEN 'ORDER_UPDATED' THEN 'ORDER_UPDATED'
               WHEN 'STATUS_CHANGED' THEN 'ORDER_STATUS_CHANGED'
               WHEN 'LOCKED' THEN 'ORDER_LOCKED'
               WHEN 'ITEM_ADDED' THEN 'ORDER_ITEM_ADDED'
               WHEN 'ITEM_UPDATED' THEN 'ORDER_ITEM_UPDATED'
               WHEN 'ITEM_REMOVED' THEN 'ORDER_ITEM_REMOVED'
               WHEN 'ITEM_RECEIPT' THEN 'ORDER_ITEM_RECEIPT'
               END AS action,
           CASE h.change_type
               WHEN 'CREATED' THEN jsonb_build_object(
                       'lineCount', CASE
                                        WHEN jsonb_typeof(h.changes -> 'items') = 'array'
                                            THEN jsonb_array_length(h.changes -> 'items') END,
                       'totalQty', (SELECT sum((i #>> '{fields,qty,to}')::numeric)
                                    FROM jsonb_array_elements(
                                                 CASE
                                                     WHEN jsonb_typeof(h.changes -> 'items') = 'array'
                                                         THEN h.changes -> 'items'
                                                     ELSE '[]'::jsonb END) i))
               WHEN 'ORDER_UPDATED' THEN jsonb_build_object('fields', h.changes -> 'order')
               WHEN 'STATUS_CHANGED' THEN jsonb_build_object(
                       'status', h.changes #> '{order,status}',
                       'autoReceived', (SELECT nullif(count(*), 0)
                                        FROM wh.order_history r
                                        WHERE h.changes #>> '{order,status,to}' = 'IN_WAREHOUSE'
                                          AND r.order_id_fk = h.order_id_fk
                                          AND r.created_at = h.created_at
                                          AND r.change_type = 'ITEM_RECEIPT'))
               WHEN 'LOCKED' THEN jsonb_build_object(
                       'fee', (SELECT f.amount
                               FROM wh.total_fees f
                               WHERE f.order_id_fk = o.id
                                 AND f.is_protected
                               LIMIT 1),
                       'prevBalance', lc.prev_balance,
                       'newBalance', lc.new_balance)
               ELSE jsonb_build_object('item', h.changes -> 'item')
               END AS extra
    ) m
WHERE m.action IS NOT NULL
  -- Auto-receipts are folded into their status change's `autoReceived` count.
  AND NOT (h.change_type = 'ITEM_RECEIPT' AND EXISTS (
    SELECT 1
    FROM wh.order_history s
    WHERE s.order_id_fk = h.order_id_fk
      AND s.created_at = h.created_at
      AND s.change_type = 'STATUS_CHANGED'
      AND s.changes #>> '{order,status,to}' = 'IN_WAREHOUSE'))
  AND NOT EXISTS (SELECT 1
                  FROM wh.activity_log a
                  WHERE a.entity_id = o.id
                    AND a.action = m.action
                    AND a.created_at = h.created_at)
ON CONFLICT (id) DO NOTHING;

-- 2. shipment_history --------------------------------------------------------------
INSERT INTO wh.activity_log (id, org_id_fk, actor_id_fk, subject_user_id_fk, entity_type,
                             entity_id, action, summary, created_at)
SELECT h.id,
       s.org_id_fk,
       h.changed_by_fk,
       s.user_id_fk,
       'SHIPMENT',
       s.id,
       m.action,
       pg_temp.strip_top_nulls(
               jsonb_build_object('shipmentNumber', s.shipment_number, 'note', h.note) || m.extra),
       h.created_at
FROM wh.shipment_history h
         JOIN wh.shipments s ON s.id = h.shipment_id_fk
         LEFT JOIN LATERAL (
    SELECT c.prev_balance, c.new_balance
    FROM wh.credit_history c
    WHERE h.change_type = 'LOCKED'
      AND c.shipment_id_fk = s.id
      AND c.entry_type = 'SHIPMENT_LOCK'
    ORDER BY c.created_at
    LIMIT 1
    ) lc ON true
         CROSS JOIN LATERAL (
    SELECT CASE h.change_type
               WHEN 'CREATED' THEN 'SHIPMENT_PLACED'
               WHEN 'ITEMS_CHANGED' THEN 'SHIPMENT_ITEMS_CHANGED'
               WHEN 'LOCKED' THEN 'SHIPMENT_LOCKED'
               WHEN 'STATUS_CHANGED' THEN 'SHIPMENT_STATUS_CHANGED'
               END AS action,
           CASE h.change_type
               WHEN 'CREATED' THEN jsonb_build_object(
                       'lineCount', CASE
                                        WHEN jsonb_typeof(h.changes -> 'items') = 'array'
                                            THEN jsonb_array_length(h.changes -> 'items') END,
                       'totalQty', (SELECT sum((i #>> '{fields,qty,to}')::numeric)
                                    FROM jsonb_array_elements(
                                                 CASE
                                                     WHEN jsonb_typeof(h.changes -> 'items') = 'array'
                                                         THEN h.changes -> 'items'
                                                     ELSE '[]'::jsonb END) i))
               WHEN 'ITEMS_CHANGED' THEN jsonb_build_object('items', h.changes -> 'items')
               WHEN 'STATUS_CHANGED' THEN jsonb_build_object('status', h.changes #> '{shipment,status}')
               WHEN 'LOCKED' THEN jsonb_build_object(
                       'fee', (SELECT f.amount
                               FROM wh.total_fees f
                               WHERE f.shipment_id_fk = s.id
                                 AND f.is_protected
                               LIMIT 1),
                       'prevBalance', lc.prev_balance,
                       'newBalance', lc.new_balance)
               END AS extra
    ) m
WHERE m.action IS NOT NULL
  AND NOT EXISTS (SELECT 1
                  FROM wh.activity_log a
                  WHERE a.entity_id = s.id
                    AND a.action = m.action
                    AND a.created_at = h.created_at)
ON CONFLICT (id) DO NOTHING;

-- 3. credit_history: extra fees (logged against their order / shipment) -------------
INSERT INTO wh.activity_log (id, org_id_fk, actor_id_fk, subject_user_id_fk, entity_type,
                             entity_id, action, summary, created_at)
SELECT c.id,
       c.org_id_fk,
       CASE WHEN c.amount < 0 THEN f.created_by_fk ELSE f.voided_by_fk END,
       c.user_id_fk,
       m.entity_type,
       m.entity_id,
       m.action,
       pg_temp.strip_top_nulls(jsonb_build_object(
               'orderNumber', o.order_number,
               'shipmentNumber', s.shipment_number,
               'feeId', c.fee_id_fk,
               'feeName', f.name,
               'amount', c.amount,
               'prevBalance', c.prev_balance,
               'newBalance', c.new_balance,
               'note', c.note)),
       c.created_at
FROM wh.credit_history c
         LEFT JOIN wh.total_fees f ON f.id = c.fee_id_fk
         LEFT JOIN wh.orders o ON o.id = c.order_id_fk
         LEFT JOIN wh.shipments s ON s.id = c.shipment_id_fk
         CROSS JOIN LATERAL (
    SELECT CASE WHEN c.order_id_fk IS NOT NULL THEN 'ORDER' ELSE 'SHIPMENT' END AS entity_type,
           coalesce(c.order_id_fk, c.shipment_id_fk)                           AS entity_id,
           CASE
               WHEN c.order_id_fk IS NOT NULL AND c.amount < 0 THEN 'ORDER_FEE_ADDED'
               WHEN c.order_id_fk IS NOT NULL THEN 'ORDER_FEE_VOIDED'
               WHEN c.amount < 0 THEN 'SHIPMENT_FEE_ADDED'
               ELSE 'SHIPMENT_FEE_VOIDED'
               END                                                             AS action
    ) m
WHERE c.entry_type = 'EXTRA_FEE'
  AND m.entity_id IS NOT NULL -- the order/shipment was deleted (FK set null)
  AND NOT EXISTS (SELECT 1
                  FROM wh.activity_log a
                  WHERE a.entity_id = m.entity_id
                    AND a.action = m.action
                    AND a.created_at = c.created_at)
ON CONFLICT (id) DO NOTHING;

-- 4. credit_history: top-ups, adjustments, reseller commissions -------------------
INSERT INTO wh.activity_log (id, org_id_fk, actor_id_fk, subject_user_id_fk, entity_type,
                             entity_id, action, summary, created_at)
SELECT c.id,
       c.org_id_fk,
       -- A commission's actor is the reviewer who locked (the lock fee's creator);
       -- top-ups / adjustments never recorded who made them.
       CASE WHEN c.entry_type = 'RESELLER_COMMISSION' THEN f.created_by_fk END,
       c.user_id_fk,
       'CREDIT',
       c.id,
       CASE c.entry_type
           WHEN 'TOP_UP' THEN 'CREDIT_TOPPED_UP'
           WHEN 'ADJUSTMENT' THEN 'CREDIT_ADJUSTED'
           ELSE 'CREDIT_COMMISSION'
           END,
       pg_temp.strip_top_nulls(jsonb_build_object(
               'orderNumber', o.order_number,
               'shipmentNumber', s.shipment_number,
               'amount', c.amount,
               'prevBalance', c.prev_balance,
               'newBalance', c.new_balance,
               'note', c.note)),
       c.created_at
FROM wh.credit_history c
         LEFT JOIN wh.total_fees f ON f.id = c.fee_id_fk
         LEFT JOIN wh.orders o ON o.id = c.order_id_fk
         LEFT JOIN wh.shipments s ON s.id = c.shipment_id_fk
WHERE c.entry_type IN ('TOP_UP', 'ADJUSTMENT', 'RESELLER_COMMISSION')
  AND NOT EXISTS (SELECT 1 FROM wh.activity_log a WHERE a.entity_id = c.id)
ON CONFLICT (id) DO NOTHING;

-- 5. shipment_labels: the currently attached label, as uploaded by the client ------
INSERT INTO wh.activity_log (id, org_id_fk, actor_id_fk, subject_user_id_fk, entity_type,
                             entity_id, action, summary, created_at)
SELECT l.id,
       s.org_id_fk,
       s.user_id_fk, -- only the owning client can upload a label
       s.user_id_fk,
       'SHIPMENT',
       s.id,
       'SHIPMENT_LABEL_SET',
       jsonb_build_object('shipmentNumber', s.shipment_number),
       l.created_at
FROM wh.shipment_labels l
         JOIN wh.shipments s ON s.id = l.shipment_id_fk
WHERE NOT EXISTS (SELECT 1
                  FROM wh.activity_log a
                  WHERE a.entity_id = s.id
                    AND a.action = 'SHIPMENT_LABEL_SET'
                    AND a.created_at = l.created_at)
ON CONFLICT (id) DO NOTHING;

COMMIT;
