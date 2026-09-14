-- Narrow wh.users.created_at to millisecond precision (timestamp(3)) so it can
-- safely back keyset (cursor) pagination for the user directory
-- (GET /organizations/users). The opaque cursor round-trips a row's created_at
-- through a JS Date, which is millisecond-precision, so a microsecond-precision
-- column would let the (created_at, id) seek skip rows that share a millisecond
-- but differ in their sub-millisecond digits. This mirrors the timestamp(3)
-- created_at already used on orders / order_history / credit_history that the
-- other keyset lists page on.
--
-- Idempotent: re-running the ALTER is a no-op cast once the column is already
-- timestamp(3).
ALTER TABLE wh.users
  ALTER COLUMN created_at TYPE timestamp(3) with time zone;
