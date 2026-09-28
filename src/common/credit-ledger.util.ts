import { BadRequestException } from '@nestjs/common';
import { SelectQueryBuilder } from 'typeorm';
import { CreditEntryType, CreditHistory } from '../entities/credit-history.entity';

const CREDIT_ENTRY_TYPE_VALUES = new Set<string>(Object.values(CreditEntryType));

/** The charge entry types a client's spend nets over (voided extra fees cancel out). */
export const SPEND_ENTRY_TYPES: CreditEntryType[] = [
  CreditEntryType.ORDER_LOCK,
  CreditEntryType.SHIPMENT_LOCK,
  CreditEntryType.EXTRA_FEE,
];

/**
 * Optional filters shared by both credit-ledger read paths (`getMemberCredit`,
 * `UserService.getMyCredit`) and their summaries. `from` is inclusive, `to`
 * exclusive; `orgId` is only honored on the per-user (`/me`) path — the org-scoped
 * path always pins its own org.
 */
export interface LedgerFilters {
  types: CreditEntryType[];
  from?: Date;
  to?: Date;
  orgId?: string;
  /** Narrow to one member — only honored on the org-wide (`/organizations/:orgId/credit/*`) paths. */
  userId?: string;
}

/** Raw query-string form of {@link LedgerFilters}, as the controllers receive it. */
export interface LedgerFilterQuery {
  type?: string;
  from?: string;
  to?: string;
  orgId?: string;
  userId?: string;
}

/**
 * Parse the ledger filter query strings. `type` is a comma-separated list of
 * `CreditEntryType` (unknown values are dropped, like the order `status` filter);
 * `from`/`to` must be parseable dates or the request is rejected with a 400.
 */
export function parseLedgerFilters(raw: LedgerFilterQuery): LedgerFilters {
  const types = (raw.type ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter((s) => CREDIT_ENTRY_TYPE_VALUES.has(s)) as CreditEntryType[];

  const from = parseDateBound(raw.from, 'from');
  const to = parseDateBound(raw.to, 'to');
  if (from && to && from >= to) throw new BadRequestException('from must be before to');

  return { types, from, to, orgId: raw.orgId || undefined, userId: raw.userId || undefined };
}

function parseDateBound(raw: string | undefined, name: string): Date | undefined {
  if (raw === undefined || raw === '') return undefined;
  const date = new Date(raw);
  if (Number.isNaN(date.getTime())) throw new BadRequestException(`${name} must be a valid date`);
  return date;
}

/** Apply {@link LedgerFilters} to a `credit_history` query aliased as `c`. */
export function applyLedgerFilters(
  qb: SelectQueryBuilder<CreditHistory>,
  filters: LedgerFilters,
): SelectQueryBuilder<CreditHistory> {
  if (filters.types.length > 0) qb.andWhere('c.entryType IN (:...types)', { types: filters.types });
  if (filters.from) qb.andWhere('c.createdAt >= :from', { from: filters.from });
  if (filters.to) qb.andWhere('c.createdAt < :to', { to: filters.to });
  if (filters.orgId) qb.andWhere('c.orgId = :filterOrgId', { filterOrgId: filters.orgId });
  if (filters.userId) qb.andWhere('c.userId = :filterUserId', { filterUserId: filters.userId });
  return qb;
}

/**
 * Join the order / shipment / fee a ledger row points at, selecting only what the
 * wallet UI needs to label and link the row (`orderNumber`, `shipmentNumber`, the
 * fee's `name` and `voidedAt`). Each relation comes back `null` when unset.
 */
export function joinLedgerRefs(
  qb: SelectQueryBuilder<CreditHistory>,
): SelectQueryBuilder<CreditHistory> {
  return qb
    .leftJoin('c.order', 'order')
    .addSelect(['order.id', 'order.orderNumber'])
    .leftJoin('c.shipment', 'shipment')
    .addSelect(['shipment.id', 'shipment.shipmentNumber'])
    .leftJoin('c.fee', 'fee')
    .addSelect(['fee.id', 'fee.name', 'fee.voidedAt']);
}

/** Per-entry-type totals over a filtered ledger slice. */
export interface LedgerSummary {
  /** Signed net `amount` and row count per entry type (every type present, zero-filled). */
  totals: Record<CreditEntryType, { amount: number; count: number }>;
  /** What the client was charged, net of voids: `-SUM(amount)` over the charge types. */
  spent: number;
  /** Funds added via top-ups. */
  toppedUp: number;
}

/**
 * Aggregate a `credit_history` query (aliased `c`, already scoped + filtered) into a
 * {@link LedgerSummary} with one `GROUP BY entry_type`.
 */
export async function summarizeLedger(
  qb: SelectQueryBuilder<CreditHistory>,
): Promise<LedgerSummary> {
  const rows = await qb
    .select('c.entryType', 'entryType')
    .addSelect('COALESCE(SUM(c.amount), 0)', 'amount')
    .addSelect('COUNT(*)', 'count')
    .groupBy('c.entryType')
    .getRawMany<{ entryType: CreditEntryType; amount: string; count: string }>();

  const totals = Object.fromEntries(
    Object.values(CreditEntryType).map((t) => [t, { amount: 0, count: 0 }]),
  ) as LedgerSummary['totals'];
  for (const row of rows) {
    totals[row.entryType] = { amount: parseFloat(row.amount), count: parseInt(row.count, 10) };
  }

  const spent = -SPEND_ENTRY_TYPES.reduce((sum, t) => sum + totals[t].amount, 0);
  return { totals, spent, toppedUp: totals[CreditEntryType.TOP_UP].amount };
}

/**
 * Validate an IANA time zone name for day bucketing (e.g. `Asia/Bangkok`), falling
 * back to UTC when omitted. Rejects names the runtime doesn't recognize with a 400.
 */
export function parseTimeZone(raw?: string): string {
  if (raw === undefined || raw === '') return 'UTC';
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: raw });
    return raw;
  } catch {
    throw new BadRequestException('tz must be a valid IANA time zone');
  }
}

/** One calendar day of a ledger slice (in the requested time zone). */
export interface LedgerDay {
  /** Local calendar date, `YYYY-MM-DD`. */
  date: string;
  /** Money out that day (charges and deductions), as a positive number. */
  spent: number;
  /** Money in that day (top-ups, refunds, positive adjustments). */
  added: number;
  count: number;
  /** Balance after the day's last entry in the slice. */
  closingBalance: number;
}

/**
 * Aggregate a `credit_history` query (aliased `c`, already scoped + filtered) into
 * per-day totals, newest day first, bucketing `created_at` by calendar day in `tz`.
 */
export async function summarizeLedgerByDay(
  qb: SelectQueryBuilder<CreditHistory>,
  tz: string,
): Promise<LedgerDay[]> {
  // closingBalance is one user's wallet balance, so it is only meaningful when the
  // slice is scoped to a single user; org-wide callers should ignore it.
  const rows = await qb
    .select(`to_char(c.createdAt AT TIME ZONE :tz, 'YYYY-MM-DD')`, 'date')
    .addSelect('COALESCE(SUM(-c.amount) FILTER (WHERE c.amount < 0), 0)', 'spent')
    .addSelect('COALESCE(SUM(c.amount) FILTER (WHERE c.amount > 0), 0)', 'added')
    .addSelect('COUNT(*)', 'count')
    .addSelect(
      '(array_agg(c.newBalance ORDER BY c.createdAt DESC, c.id DESC))[1]',
      'closingBalance',
    )
    .setParameter('tz', tz)
    .groupBy('1')
    .orderBy('1', 'DESC')
    .getRawMany<{
      date: string;
      spent: string;
      added: string;
      count: string;
      closingBalance: string;
    }>();

  return rows.map((r) => ({
    date: r.date,
    spent: parseFloat(r.spent),
    added: parseFloat(r.added),
    count: parseInt(r.count, 10),
    closingBalance: parseFloat(r.closingBalance),
  }));
}
