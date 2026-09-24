-- 0006-create-credit-groups.sql
-- Credit groups: a billing-only construct (unrelated to permission `org_groups`) that
-- gives a set of clients a marked-up lock fee. Each group is scoped to an org, has an
-- owner (the reviewer/reseller who earns the markup) and its own per-fee_type amounts;
-- a client belongs to at most one credit group per org. On lock, the group fee
-- overrides the org fee as what the client pays; the owner is credited (group fee − org
-- fee) and the warehouse keeps the org fee. Forward-only, idempotent.

CREATE TABLE IF NOT EXISTS wh.credit_groups
(
    id         uuid                        default gen_random_uuid() not null
        primary key,
    name       varchar(255)                                          not null,
    org_id_fk  uuid                                                  not null
        references wh.organizations
            on update cascade on delete cascade,
    owner_id_fk uuid                                                 not null
        references wh.users
            on update cascade on delete cascade,
    created_at timestamp(3) with time zone default now()             not null,
    updated_at timestamp with time zone
);

-- Group names are unique per org.
CREATE UNIQUE INDEX IF NOT EXISTS credit_groups_org_name_unique
    ON wh.credit_groups (org_id_fk, name);

-- Reverse lookups.
CREATE INDEX IF NOT EXISTS credit_groups_org_idx ON wh.credit_groups (org_id_fk);
CREATE INDEX IF NOT EXISTS credit_groups_owner_idx ON wh.credit_groups (owner_id_fk);

CREATE TABLE IF NOT EXISTS wh.credit_group_fees
(
    credit_group_id_fk uuid        not null
        references wh.credit_groups
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

CREATE TABLE IF NOT EXISTS wh.credit_group_members
(
    credit_group_id_fk uuid                        not null
        references wh.credit_groups
            on update cascade on delete cascade,
    user_id_fk         uuid                        not null
        references wh.users
            on update cascade on delete cascade,
    org_id_fk          uuid                        not null
        references wh.organizations
            on update cascade on delete cascade,
    created_at         timestamp(3) with time zone default now() not null,
    primary key (credit_group_id_fk, user_id_fk)
);

-- A client belongs to at most one credit group per org, so fee resolution is
-- unambiguous. `org_id_fk` is denormalized from the group to back this constraint.
CREATE UNIQUE INDEX IF NOT EXISTS credit_group_members_user_org_unique
    ON wh.credit_group_members (user_id_fk, org_id_fk);

CREATE INDEX IF NOT EXISTS credit_group_members_group_idx
    ON wh.credit_group_members (credit_group_id_fk);
