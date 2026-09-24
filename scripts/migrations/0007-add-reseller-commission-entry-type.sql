-- 0007-add-reseller-commission-entry-type.sql
-- Add RESELLER_COMMISSION to the credit_history.entry_type CHECK. It is the positive
-- credit a credit-group owner earns when a member's order/shipment is locked
-- (group fee − org fee). Forward-only; recreates the CHECK to include the new value.

ALTER TABLE wh.credit_history
    DROP CONSTRAINT IF EXISTS credit_history_entry_type_check;

ALTER TABLE wh.credit_history
    ADD CONSTRAINT credit_history_entry_type_check
        CHECK ((entry_type)::text = ANY
               (ARRAY [('ORDER_LOCK'::character varying)::text,
                       ('SHIPMENT_LOCK'::character varying)::text,
                       ('EXTRA_FEE'::character varying)::text,
                       ('TOP_UP'::character varying)::text,
                       ('ADJUSTMENT'::character varying)::text,
                       ('RESELLER_COMMISSION'::character varying)::text]));
