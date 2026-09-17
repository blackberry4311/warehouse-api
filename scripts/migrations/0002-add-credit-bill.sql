-- Top-up bills: attach one bill/receipt image to a TOP_UP credit_history entry.
--
-- Stored in a separate `credit_resources` table (not on credit_history) so the
-- append-only ledger stays lean and this data can be cleaned up independently — a
-- bill expiry is just a DELETE here (plus its bucket object), leaving the immutable
-- ledger row untouched. The image bytes live in S3-compatible object storage
-- (Railway Buckets); this row only points at the object. One resource per credit
-- entry (unique credit_id_fk); a re-upload replaces it. A daily cron deletes rows
-- older than two weeks. Forward-only and idempotent.

create table if not exists wh.credit_resources (
    id           uuid                        default gen_random_uuid() not null
        primary key,
    credit_id_fk uuid                                                  not null
        references wh.credit_history
            on update cascade on delete cascade,
    object_key   varchar(512)                                          not null,
    content_type varchar(128),
    size         bigint,
    created_at   timestamp(3) with time zone default now()             not null
);

-- One resource (bill) per credit entry.
create unique index if not exists credit_resources_credit_unique
    on wh.credit_resources (credit_id_fk);

-- Backs the daily expiry scan (rows older than the TTL).
create index if not exists credit_resources_created_idx
    on wh.credit_resources (created_at);
