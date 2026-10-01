import { BadRequestException, ForbiddenException, Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { ObjectLiteral, Repository, SelectQueryBuilder } from 'typeorm';
import { Order, OrderStatus } from '../entities/order.entity';
import { OrderDetail, OrderDetailStatus } from '../entities/order-detail.entity';
import { Shipment, ShipmentStatus } from '../entities/shipment.entity';
import { CreditEntryType, CreditHistory } from '../entities/credit-history.entity';
import { UserOrg } from '../entities/user-org.entity';
import { OrganizationService } from '../organization/organization.service';
import {
  applyLedgerFilters,
  SPEND_ENTRY_TYPES,
  summarizeLedger,
  summarizeLedgerByDay,
} from '../common/credit-ledger.util';

/** Raw query-string form of {@link ReportFilters}, as the controller receives it. */
export interface ReportFilterQuery {
  orgId?: string;
  userId?: string;
  from?: string;
  to?: string;
}

/** Optional filters shared by every report. `from` is inclusive, `to` exclusive. */
export interface ReportFilters {
  orgId?: string;
  userId?: string;
  from?: Date;
  to?: Date;
}

/**
 * The rows a caller may aggregate over, resolved once per request:
 * - `orgIds` — `null` means every org; an empty array means none (the result is empty);
 * - `userId` — `null` means every user; otherwise only that user's rows.
 */
export interface ReportScope {
  viewAll: boolean;
  orgIds: string[] | null;
  userId: string | null;
}

export type TopClientMetric = 'orders' | 'shipments' | 'spent';
const TOP_CLIENT_METRICS = new Set<string>(['orders', 'shipments', 'spent']);

const DEFAULT_TOP_LIMIT = 10;
const MAX_TOP_LIMIT = 50;

/** Parse the report filter query strings; `from`/`to` must be dates (400 otherwise). */
export function parseReportFilters(raw: ReportFilterQuery): ReportFilters {
  const from = parseDateBound(raw.from, 'from');
  const to = parseDateBound(raw.to, 'to');
  if (from && to && from >= to) throw new BadRequestException('from must be before to');
  return { orgId: raw.orgId || undefined, userId: raw.userId || undefined, from, to };
}

function parseDateBound(raw: string | undefined, name: string): Date | undefined {
  if (raw === undefined || raw === '') return undefined;
  const date = new Date(raw);
  if (Number.isNaN(date.getTime())) throw new BadRequestException(`${name} must be a valid date`);
  return date;
}

export function parseTopClientMetric(raw?: string): TopClientMetric {
  if (raw === undefined || raw === '') return 'orders';
  if (!TOP_CLIENT_METRICS.has(raw)) {
    throw new BadRequestException('metric must be one of orders, shipments, spent');
  }
  return raw as TopClientMetric;
}

function parseTopLimit(raw?: string): number {
  const n = parseInt(raw ?? '', 10);
  if (Number.isNaN(n) || n < 1) return DEFAULT_TOP_LIMIT;
  return Math.min(n, MAX_TOP_LIMIT);
}

/** Zero-filled `{ [status]: count }` from `GROUP BY status` rows. */
function countByStatus<S extends string>(
  statuses: S[],
  rows: { status: S; count: string }[],
): Record<S, number> {
  const out = Object.fromEntries(statuses.map((s) => [s, 0])) as Record<S, number>;
  for (const row of rows) out[row.status] = parseInt(row.count, 10);
  return out;
}

/**
 * Read-only aggregates over orders, shipments, inventory and the credit ledger for
 * the dashboard and the report pages.
 *
 * Scoping (see {@link resolveScope}): a holder of `view_all_report` — granted in any
 * org — or a system admin reports over every org and every user, optionally narrowed
 * by `orgId` / `userId`. Everyone else reports only over **their own** rows (orders /
 * shipments they placed, their own ledger) within the orgs they belong to.
 */
@Injectable()
export class ReportService {
  constructor(
    @InjectRepository(Order) private orderRepo: Repository<Order>,
    @InjectRepository(OrderDetail) private detailRepo: Repository<OrderDetail>,
    @InjectRepository(Shipment) private shipmentRepo: Repository<Shipment>,
    @InjectRepository(CreditHistory) private creditRepo: Repository<CreditHistory>,
    @InjectRepository(UserOrg) private userOrgRepo: Repository<UserOrg>,
    private readonly orgService: OrganizationService,
  ) {}

  /**
   * Resolve what the caller may see. `view_all_report` is a global grant: holding it
   * in any org (or being a system admin) opens every org and user. Without it, the
   * caller is pinned to their own rows in the orgs they belong to — asking for an org
   * they are not in, or for another user, is a 403.
   */
  async resolveScope(actingUserId: string, filters: ReportFilters): Promise<ReportScope> {
    if (filters.orgId) await this.orgService.getOrganization(filters.orgId);

    const grantedOrgIds = await this.orgService.getOrgIdsWithPermission(
      actingUserId,
      'view_all_report',
    );
    const viewAll = grantedOrgIds === null || grantedOrgIds.length > 0;

    if (viewAll) {
      return {
        viewAll,
        orgIds: filters.orgId ? [filters.orgId] : null,
        userId: filters.userId ?? null,
      };
    }

    if (filters.userId && filters.userId !== actingUserId) {
      throw new ForbiddenException("You cannot view another user's report");
    }

    const memberships = await this.userOrgRepo.find({ where: { userId: actingUserId } });
    const memberOrgIds = memberships.map((m) => m.orgId);
    if (filters.orgId && !memberOrgIds.includes(filters.orgId)) {
      throw new ForbiddenException('You do not belong to this organization');
    }

    return {
      viewAll,
      orgIds: filters.orgId ? [filters.orgId] : memberOrgIds,
      userId: actingUserId,
    };
  }

  /**
   * Headline numbers for the dashboard: orders and their lines by status, shipments by
   * status with quantities, the current inventory (not period-filtered — it is stock on
   * hand now), and the credit ledger totals. `earnings` (what the warehouse keeps, net
   * of voids and reseller commissions) is only computed for an org-wide `view_all_report`
   * scope — on a per-user slice the commission lands in another user's wallet, so the
   * figure would be wrong.
   */
  async getOverview(actingUserId: string, filters: ReportFilters) {
    const scope = await this.resolveScope(actingUserId, filters);

    const [orderRows, lineRows, shipmentRows, inventoryRow, credit] = await Promise.all([
      this.periodScoped(this.orderRepo.createQueryBuilder('o'), 'o', scope, filters)
        .select('o.status', 'status')
        .addSelect('COUNT(*)', 'count')
        .groupBy('o.status')
        .getRawMany<{ status: OrderStatus; count: string }>(),
      this.periodScoped(
        this.detailRepo.createQueryBuilder('d').innerJoin('d.order', 'o'),
        'o',
        scope,
        filters,
      )
        .select('d.status', 'status')
        .addSelect('COUNT(*)', 'count')
        .addSelect('COALESCE(SUM(d.qty), 0)', 'qty')
        .groupBy('d.status')
        .getRawMany<{ status: OrderDetailStatus; count: string; qty: string }>(),
      this.periodScoped(
        this.shipmentRepo.createQueryBuilder('s').leftJoin('s.items', 'sd'),
        's',
        scope,
        filters,
      )
        .select('s.status', 'status')
        .addSelect('COUNT(DISTINCT s.id)', 'count')
        .addSelect('COALESCE(SUM(sd.qty), 0)', 'qty')
        .groupBy('s.status')
        .getRawMany<{ status: ShipmentStatus; count: string; qty: string }>(),
      this.scoped(this.detailRepo.createQueryBuilder('d').innerJoin('d.order', 'o'), 'o', scope)
        .andWhere('d.status = :received', { received: OrderDetailStatus.RECEIVED })
        .andWhere('d.qty > d.shippedQty')
        .select('COUNT(*)', 'lines')
        .addSelect('COALESCE(SUM(d.qty - d.shippedQty), 0)', 'remaining')
        .getRawOne<{ lines: string; remaining: string }>(),
      summarizeLedger(this.creditQuery(scope, filters)),
    ]);

    const lines = Object.fromEntries(
      Object.values(OrderDetailStatus).map((s) => [s, { count: 0, qty: 0 }]),
    ) as Record<OrderDetailStatus, { count: number; qty: number }>;
    for (const row of lineRows) {
      lines[row.status] = { count: parseInt(row.count, 10), qty: parseFloat(row.qty) };
    }

    const shipmentQty = Object.fromEntries(
      Object.values(ShipmentStatus).map((s) => [s, 0]),
    ) as Record<ShipmentStatus, number>;
    for (const row of shipmentRows) shipmentQty[row.status] = parseFloat(row.qty);

    const earnings =
      scope.viewAll && !scope.userId
        ? -[...SPEND_ENTRY_TYPES, CreditEntryType.RESELLER_COMMISSION].reduce(
            (sum, t) => sum + credit.totals[t].amount,
            0,
          )
        : null;

    return {
      scope: this.describeScope(scope),
      from: filters.from ?? null,
      to: filters.to ?? null,
      orders: {
        byStatus: countByStatus(Object.values(OrderStatus), orderRows),
        lines,
      },
      shipments: {
        byStatus: countByStatus(Object.values(ShipmentStatus), shipmentRows),
        qtyByStatus: shipmentQty,
      },
      inventory: {
        lines: parseInt(inventoryRow?.lines ?? '0', 10),
        remaining: parseFloat(inventoryRow?.remaining ?? '0'),
      },
      credit: { ...credit, earnings },
    };
  }

  /**
   * Orders placed per calendar day in `tz`, newest day first: how many (and how many
   * are now in each status), the declared quantity (cancelled lines excluded) and the
   * quantity already received into the warehouse.
   */
  async getOrdersDaily(actingUserId: string, filters: ReportFilters, tz: string) {
    const scope = await this.resolveScope(actingUserId, filters);

    const rows = await this.periodScoped(
      this.orderRepo.createQueryBuilder('o').leftJoin('o.details', 'd'),
      'o',
      scope,
      filters,
    )
      .select(`to_char(o.createdAt AT TIME ZONE :tz, 'YYYY-MM-DD')`, 'date')
      .addSelect('COUNT(DISTINCT o.id)', 'orders')
      .addSelect('COUNT(DISTINCT o.id) FILTER (WHERE o.status = :inTransit)', 'inTransit')
      .addSelect('COUNT(DISTINCT o.id) FILTER (WHERE o.status = :inWarehouse)', 'inWarehouse')
      .addSelect('COUNT(DISTINCT o.id) FILTER (WHERE o.status = :orderCancelled)', 'cancelled')
      .addSelect('COALESCE(SUM(d.qty) FILTER (WHERE d.status <> :lineCancelled), 0)', 'qty')
      .addSelect('COALESCE(SUM(d.qty) FILTER (WHERE d.status = :received), 0)', 'receivedQty')
      .setParameters({
        tz,
        inTransit: OrderStatus.IN_TRANSIT,
        inWarehouse: OrderStatus.IN_WAREHOUSE,
        orderCancelled: OrderStatus.CANCELLED,
        lineCancelled: OrderDetailStatus.CANCELLED,
        received: OrderDetailStatus.RECEIVED,
      })
      .groupBy('1')
      .orderBy('1', 'DESC')
      .getRawMany<Record<string, string>>();

    return {
      scope: this.describeScope(scope),
      tz,
      days: rows.map((r) => ({
        date: r.date,
        orders: parseInt(r.orders, 10),
        inTransit: parseInt(r.inTransit, 10),
        inWarehouse: parseInt(r.inWarehouse, 10),
        cancelled: parseInt(r.cancelled, 10),
        qty: parseFloat(r.qty),
        receivedQty: parseFloat(r.receivedQty),
      })),
    };
  }

  /**
   * Shipments requested per calendar day in `tz`, newest day first: how many (and how
   * many are now in each status), the requested quantity (cancelled shipments
   * excluded) and the quantity already dispatched (`DONE`).
   */
  async getShipmentsDaily(actingUserId: string, filters: ReportFilters, tz: string) {
    const scope = await this.resolveScope(actingUserId, filters);

    const rows = await this.periodScoped(
      this.shipmentRepo.createQueryBuilder('s').leftJoin('s.items', 'sd'),
      's',
      scope,
      filters,
    )
      .select(`to_char(s.createdAt AT TIME ZONE :tz, 'YYYY-MM-DD')`, 'date')
      .addSelect('COUNT(DISTINCT s.id)', 'shipments')
      .addSelect('COUNT(DISTINCT s.id) FILTER (WHERE s.status = :awaiting)', 'awaiting')
      .addSelect('COUNT(DISTINCT s.id) FILTER (WHERE s.status = :done)', 'done')
      .addSelect('COUNT(DISTINCT s.id) FILTER (WHERE s.status = :cancelled)', 'cancelled')
      .addSelect('COALESCE(SUM(sd.qty) FILTER (WHERE s.status <> :cancelled), 0)', 'qty')
      .addSelect('COALESCE(SUM(sd.qty) FILTER (WHERE s.status = :done), 0)', 'doneQty')
      .setParameters({
        tz,
        awaiting: ShipmentStatus.AWAITING,
        done: ShipmentStatus.DONE,
        cancelled: ShipmentStatus.CANCELLED,
      })
      .groupBy('1')
      .orderBy('1', 'DESC')
      .getRawMany<Record<string, string>>();

    return {
      scope: this.describeScope(scope),
      tz,
      days: rows.map((r) => ({
        date: r.date,
        shipments: parseInt(r.shipments, 10),
        awaiting: parseInt(r.awaiting, 10),
        done: parseInt(r.done, 10),
        cancelled: parseInt(r.cancelled, 10),
        qty: parseFloat(r.qty),
        doneQty: parseFloat(r.doneQty),
      })),
    };
  }

  /**
   * The scoped credit ledger rolled up per calendar day in `tz`, newest first. The
   * closing balance is only meaningful for a single user's slice, so it is dropped
   * otherwise.
   */
  async getCreditDaily(actingUserId: string, filters: ReportFilters, tz: string) {
    const scope = await this.resolveScope(actingUserId, filters);
    const days = await summarizeLedgerByDay(this.creditQuery(scope, filters), tz);
    const singleUser = scope.userId !== null;

    return {
      scope: this.describeScope(scope),
      tz,
      days: days.map(({ date, spent, added, count, closingBalance }) =>
        singleUser ? { date, spent, added, count, closingBalance } : { date, spent, added, count },
      ),
    };
  }

  /**
   * Clients ranked by `metric` over the period — orders placed, shipments requested
   * (both excluding cancelled) or credit spent (net of voids). Without
   * `view_all_report` the ranking only ever contains the caller.
   */
  async getTopClients(
    actingUserId: string,
    filters: ReportFilters,
    metric: TopClientMetric,
    limitRaw?: string,
  ) {
    const scope = await this.resolveScope(actingUserId, filters);
    const limit = parseTopLimit(limitRaw);

    let qb: SelectQueryBuilder<ObjectLiteral>;
    if (metric === 'spent') {
      qb = this.creditQuery(scope, filters)
        .andWhere('c.entryType IN (:...spendTypes)', { spendTypes: SPEND_ENTRY_TYPES })
        .innerJoin('c.user', 'u')
        .select('-SUM(c.amount)', 'value');
    } else if (metric === 'orders') {
      qb = this.periodScoped(this.orderRepo.createQueryBuilder('o'), 'o', scope, filters)
        .andWhere('o.status <> :cancelled', { cancelled: OrderStatus.CANCELLED })
        .innerJoin('o.user', 'u')
        .select('COUNT(*)', 'value');
    } else {
      qb = this.periodScoped(this.shipmentRepo.createQueryBuilder('s'), 's', scope, filters)
        .andWhere('s.status <> :cancelled', { cancelled: ShipmentStatus.CANCELLED })
        .innerJoin('s.user', 'u')
        .select('COUNT(*)', 'value');
    }

    const rows = await qb
      .addSelect('u.id', 'id')
      .addSelect('u.email', 'email')
      .addSelect('u.displayName', 'displayName')
      .addSelect('u.code', 'code')
      .groupBy('u.id')
      .orderBy('value', 'DESC')
      .limit(limit)
      .getRawMany<{
        id: string;
        email: string;
        displayName: string;
        code: string | null;
        value: string;
      }>();

    return {
      scope: this.describeScope(scope),
      metric,
      from: filters.from ?? null,
      to: filters.to ?? null,
      items: rows.map((r) => ({
        user: { id: r.id, email: r.email, displayName: r.displayName, code: r.code },
        value: parseFloat(r.value),
      })),
    };
  }

  /** Echo the resolved scope so the FE knows whether it got an all-org or a personal view. */
  private describeScope(scope: ReportScope) {
    return {
      viewAll: scope.viewAll,
      orgIds: scope.orgIds,
      userId: scope.userId,
    };
  }

  /** Pin a query to the scope on `<alias>.orgId` / `<alias>.userId`. */
  private scoped<T extends ObjectLiteral>(
    qb: SelectQueryBuilder<T>,
    alias: string,
    scope: ReportScope,
  ): SelectQueryBuilder<T> {
    if (scope.orgIds !== null) {
      if (scope.orgIds.length === 0) qb.andWhere('1 = 0');
      else qb.andWhere(`${alias}.orgId IN (:...scopeOrgIds)`, { scopeOrgIds: scope.orgIds });
    }
    if (scope.userId !== null) {
      qb.andWhere(`${alias}.userId = :scopeUserId`, { scopeUserId: scope.userId });
    }
    return qb;
  }

  /** {@link scoped}, plus the `from` / `to` period on `<alias>.createdAt`. */
  private periodScoped<T extends ObjectLiteral>(
    qb: SelectQueryBuilder<T>,
    alias: string,
    scope: ReportScope,
    filters: ReportFilters,
  ): SelectQueryBuilder<T> {
    this.scoped(qb, alias, scope);
    if (filters.from) qb.andWhere(`${alias}.createdAt >= :from`, { from: filters.from });
    if (filters.to) qb.andWhere(`${alias}.createdAt < :to`, { to: filters.to });
    return qb;
  }

  /** The scoped, period-filtered credit ledger (aliased `c`). */
  private creditQuery(scope: ReportScope, filters: ReportFilters) {
    const qb = this.scoped(this.creditRepo.createQueryBuilder('c'), 'c', scope);
    return applyLedgerFilters(qb, { types: [], from: filters.from, to: filters.to });
  }
}
