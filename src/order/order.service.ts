import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { EntityManager, In, Repository } from 'typeorm';
import { Order, OrderStatus } from '../entities/order.entity';
import { OrderDetail, OrderDetailStatus } from '../entities/order-detail.entity';
import {
  FieldDiff,
  OrderChange,
  OrderChangeType,
  OrderHistory,
  OrderItemChange,
} from '../entities/order-history.entity';
import { User } from '../entities/user.entity';
import { FeeType, OrgFee } from '../entities/org-fee.entity';
import { CreditEntryType, CreditHistory } from '../entities/credit-history.entity';
import { TotalFee } from '../entities/total-fee.entity';
import { OrganizationService } from '../organization/organization.service';
import { PlaceOrderDto } from './dto/place-order.dto';
import { UpdateOrderDto } from './dto/update-order.dto';
import { UpdateOrderStatusDto } from './dto/update-order-status.dto';
import { AddOrderDetailDto } from './dto/add-order-detail.dto';
import { UpdateOrderDetailDto } from './dto/update-order-detail.dto';
import { UpdateOrderDetailStatusDto } from './dto/update-order-detail-status.dto';
import { LockOrderDto } from './dto/lock-order.dto';
import { decodeCursor, Page, parseLimit, toPage } from '../common/pagination.util';
import { creditCommission, resolveClientFee } from '../common/credit-group.util';

/**
 * Status moves the **client** (order owner) may make while the order is still
 * unlocked. With the lifecycle simplified to a single initial state, the client can
 * only cancel a still-in-transit order (line changes go through the /details routes).
 */
const CLIENT_TRANSITIONS: Record<OrderStatus, OrderStatus[]> = {
  [OrderStatus.IN_TRANSIT]: [OrderStatus.CANCELLED],
  [OrderStatus.IN_WAREHOUSE]: [],
  [OrderStatus.CANCELLED]: [],
};

/**
 * Status moves **operations** (process_order) may make, once the order is locked:
 * confirm the goods into the warehouse (at which point the lines become inventory),
 * or cancel. CANCELLED is reachable from any live state.
 */
const PROCESS_TRANSITIONS: Record<OrderStatus, OrderStatus[]> = {
  [OrderStatus.IN_TRANSIT]: [OrderStatus.IN_WAREHOUSE, OrderStatus.CANCELLED],
  [OrderStatus.IN_WAREHOUSE]: [OrderStatus.CANCELLED],
  [OrderStatus.CANCELLED]: [],
};

/**
 * The receipt transitions operations may drive a line through. PENDING can resolve
 * to any outcome; RECEIVED/NOT_ARRIVED allow correcting each other; CANCELLED is
 * terminal for a line.
 */
const DETAIL_TRANSITIONS: Record<OrderDetailStatus, OrderDetailStatus[]> = {
  [OrderDetailStatus.PENDING]: [
    OrderDetailStatus.RECEIVED,
    OrderDetailStatus.NOT_ARRIVED,
    OrderDetailStatus.CANCELLED,
  ],
  [OrderDetailStatus.RECEIVED]: [OrderDetailStatus.NOT_ARRIVED, OrderDetailStatus.CANCELLED],
  [OrderDetailStatus.NOT_ARRIVED]: [OrderDetailStatus.RECEIVED, OrderDetailStatus.CANCELLED],
  [OrderDetailStatus.CANCELLED]: [],
};

/** The only state in which an order can be locked / edited pre-lock. */
const PENDING_STATUSES: readonly OrderStatus[] = [OrderStatus.IN_TRANSIT];

/** Terminal states — no further transitions, no edits. */
const TERMINAL_STATUSES: readonly OrderStatus[] = [OrderStatus.CANCELLED];

const ORDER_STATUS_VALUES = new Set<string>(Object.values(OrderStatus));

/** Parse a comma-separated `status` query param into valid OrderStatus values. */
function parseStatuses(raw?: string): OrderStatus[] {
  if (!raw) return [];
  return raw
    .split(',')
    .map((s) => s.trim())
    .filter((s) => ORDER_STATUS_VALUES.has(s)) as OrderStatus[];
}

/** Parse the optional `locked` query filter; undefined means "no filter". */
function parseLocked(raw?: string): boolean | undefined {
  if (raw === 'true') return true;
  if (raw === 'false') return false;
  return undefined;
}

/**
 * What the caller is allowed to see among an org's orders, driven by the three
 * order permissions (admins hold all of them). A user may hold several.
 */
interface OrderAccess {
  /** review_order (or admin): sees every order in the org. */
  canReview: boolean;
  /** process_order: sees only locked (reviewed) orders — the operations queue. */
  canManage: boolean;
  /** place_order: sees only the orders they placed. */
  canPlace: boolean;
}

@Injectable()
export class OrderService {
  constructor(
    @InjectRepository(Order) private orderRepo: Repository<Order>,
    @InjectRepository(OrderDetail) private detailRepo: Repository<OrderDetail>,
    @InjectRepository(OrderHistory) private historyRepo: Repository<OrderHistory>,
    @InjectRepository(TotalFee) private feeRepo: Repository<TotalFee>,
    private readonly orgService: OrganizationService,
  ) {}

  /**
   * Compose a stored line name from the order client's code and their free text:
   * the free text is slugified (lowercased, each run of non-letter/digit characters
   * collapsed to a single hyphen, leading/trailing hyphens trimmed) and joined to
   * the code with a hyphen — e.g. code `ACME` + `"this is test"` → `ACME-this-is-test`.
   * Unicode letters/digits are preserved (so non-Latin text isn't stripped away). If
   * the free text slugifies to nothing, the name is just the code.
   */
  private composeName(code: string, freeText: string): string {
    const slug = freeText
      .toLowerCase()
      .replace(/[^\p{L}\p{N}]+/gu, '-')
      .replace(/^-+|-+$/gu, '');
    return slug ? `${code}-${slug}` : code;
  }

  /**
   * Ensure a user has a client `code`, assigning one lazily (self-registered users
   * may lack it). Used both for the order number and the line-name prefix.
   */
  private async ensureUserCode(em: EntityManager, userId: string): Promise<string> {
    const user = await em.findOne(User, { where: { id: userId } });
    if (!user) throw new NotFoundException('User not found');
    if (user.code) return user.code;
    const code = await this.orgService.resolveUserCode(undefined, user.displayName ?? user.email);
    await em.update(User, { id: userId }, { code });
    return code;
  }

  /** Append an `order_history` row with a structured `changes` payload (see
   * {@link OrderChange}). One row per user action. */
  private async writeHistory(
    em: EntityManager,
    orderId: string,
    actorId: string,
    changeType: OrderChangeType,
    changes: OrderChange | null,
    note: string | null,
  ): Promise<void> {
    await em.save(
      em.create(OrderHistory, { orderId, changedBy: actorId, changeType, changes, note }),
    );
  }

  /** Build the `changes.item` entry for a line: its id + name snapshot, plus any
   * per-field diffs. */
  private itemChange(detail: OrderDetail, fields?: Record<string, FieldDiff>): OrderItemChange {
    return { detailId: detail.id, name: detail.name, ...(fields ? { fields } : {}) };
  }

  /**
   * Gate for editing an order or its lines, resolved by the lock state:
   *   - while **unlocked**, only the owning client may edit, and only while the
   *     order is still IN_TRANSIT;
   *   - once **locked**, the client is frozen out and only a reviewer
   *     (`review_order`) may edit, up until the order reaches a terminal state.
   */
  private async assertEditable(order: Order, actorId: string): Promise<void> {
    if (order.locked) {
      const access = await this.resolveAccess(order.orgId, actorId);
      if (!access.canReview) {
        throw new ForbiddenException('Order is locked; only a reviewer can edit it');
      }
      if (TERMINAL_STATUSES.includes(order.status)) {
        throw new BadRequestException(`Cannot edit an order that is ${order.status}`);
      }
    } else {
      if (order.userId !== actorId) {
        throw new ForbiddenException('Only the client who placed the order can edit it');
      }
      if (order.status !== OrderStatus.IN_TRANSIT) {
        throw new BadRequestException('Order can only be edited while in transit');
      }
    }
  }

  /**
   * Place a new order into `dto.orgId` as the calling client. The order number is
   * always auto-generated as a per-(user, org) `<user code>-<6-digit seq>`. Creates
   * the order IN_TRANSIT with its line items (each PENDING) and a CREATED history
   * row — all in one transaction so the number is never a duplicate and an order
   * always has an opening history entry and at least one line.
   */
  async placeOrder(userId: string, dto: PlaceOrderDto) {
    const orgId = dto.orgId;
    await this.orgService.getOrganization(orgId);
    await this.orgService.assertOrgMembership(orgId, userId);

    return this.orderRepo.manager.transaction(async (em) => {
      const code = await this.ensureUserCode(em, userId);

      const rows: Array<{ next_seq: string }> = await em.query(
        `INSERT INTO wh.order_sequences (user_id_fk, org_id_fk, next_seq)
         VALUES ($1, $2, 1)
         ON CONFLICT (user_id_fk, org_id_fk)
           DO UPDATE SET next_seq = order_sequences.next_seq + 1
         RETURNING next_seq`,
        [userId, orgId],
      );
      const seq = Number(rows[0].next_seq);
      const orderNumber = `${code}-${String(seq).padStart(6, '0')}`;

      const order = await em.save(
        em.create(Order, {
          orderNumber,
          orgId,
          userId,
          tracking: dto.tracking,
          status: OrderStatus.IN_TRANSIT,
        }),
      );

      const details = await em.save(
        dto.details.map((d) =>
          em.create(OrderDetail, {
            orderId: order.id,
            name: this.composeName(code, d.name),
            qty: d.qty,
            note: d.note ?? null,
            status: OrderDetailStatus.PENDING,
          }),
        ),
      );

      // CREATED snapshots the header and every line (to-only diffs).
      const changes: OrderChange = {
        order: {
          tracking: { to: order.tracking },
          status: { to: OrderStatus.IN_TRANSIT },
        },
        items: details.map((d) =>
          this.itemChange(d, {
            qty: { to: d.qty },
            ...(d.note !== null ? { note: { to: d.note } } : {}),
          }),
        ),
      };
      await this.writeHistory(
        em,
        order.id,
        userId,
        OrderChangeType.CREATED,
        changes,
        dto.note ?? null,
      );

      return { ...order, details };
    });
  }

  /**
   * Resolve the caller's order-visibility across the three order permissions
   * (admins hold all). Used for row-level scoping by `listOrders` and `getOrder`.
   */
  private async resolveAccess(orgId: string, userId: string): Promise<OrderAccess> {
    const [canReview, canManage, canPlace] = await Promise.all([
      this.orgService.hasOrgPermission(orgId, userId, 'review_order'),
      this.orgService.hasOrgPermission(orgId, userId, 'process_order'),
      this.orgService.hasOrgPermission(orgId, userId, 'place_order'),
    ]);
    return { canReview, canManage, canPlace };
  }

  /**
   * List an org's orders, newest first, keyset-paginated by (created_at, id).
   * Optional filters — `status` (any of a comma-separated list), `search`
   * (order number, case-insensitive substring) and `locked` (the review gate) —
   * narrow the result and are compatible with the cursor, since none change the
   * ordering.
   */
  async listOrders(
    userId: string,
    orgId: string,
    limitRaw?: string,
    cursor?: string,
    statusRaw?: string,
    search?: string,
    lockedRaw?: string,
  ): Promise<Page<Order>> {
    await this.orgService.getOrganization(orgId);
    await this.orgService.assertOrgMembership(orgId, userId);

    const access = await this.resolveAccess(orgId, userId);

    const limit = parseLimit(limitRaw);
    const qb = this.orderRepo
      .createQueryBuilder('order')
      .where('order.orgId = :orgId', { orgId })
      .orderBy('order.createdAt', 'DESC')
      .addOrderBy('order.id', 'DESC')
      .take(limit + 1);

    // Row-level scoping. Reviewers (and admins) see everything; otherwise the
    // caller sees the union of what their permissions grant — locked orders for
    // operations (process_order), their own orders for a client (place_order).
    if (!access.canReview) {
      const scopes: string[] = [];
      if (access.canManage) scopes.push('order.locked = true');
      if (access.canPlace) scopes.push('order.userId = :ownerId');
      // The guard guarantees at least one order permission reached this route;
      // fall back to "nothing visible" defensively if somehow none apply.
      qb.andWhere(scopes.length ? `(${scopes.join(' OR ')})` : 'false', { ownerId: userId });
    }

    const locked = parseLocked(lockedRaw);
    if (locked !== undefined) {
      qb.andWhere('order.locked = :locked', { locked });
    }

    const statuses = parseStatuses(statusRaw);
    if (statuses.length > 0) {
      qb.andWhere('order.status IN (:...statuses)', { statuses });
    }

    const term = search?.trim();
    if (term) {
      qb.andWhere('order.orderNumber ILIKE :term', { term: `%${term}%` });
    }

    if (cursor) {
      const { t, id } = decodeCursor(cursor);
      qb.andWhere('(order.createdAt < :t OR (order.createdAt = :t AND order.id < :id))', {
        t: new Date(t),
        id,
      });
    }

    const page = toPage(await qb.getMany(), limit);
    await this.attachListDetails(page.items);
    return page;
  }

  /**
   * Populate each listed order's `details` (its line items) and derived `totalQty` in a
   * single batched query over the paginated slice. The FE renders each order's lines in a
   * grid on the list, so the list carries the same `details` shape as the single-order
   * read — without a per-row fetch.
   */
  private async attachListDetails(orders: Order[]): Promise<void> {
    if (orders.length === 0) return;
    const ids = orders.map((o) => o.id);

    const details = await this.detailRepo.find({
      where: { orderId: In(ids) },
      order: { createdAt: 'ASC' },
    });

    const byOrder = new Map<string, OrderDetail[]>();
    for (const d of details) {
      const list = byOrder.get(d.orderId) ?? [];
      list.push(d);
      byOrder.set(d.orderId, list);
    }

    for (const o of orders) {
      const lines = byOrder.get(o.id) ?? [];
      o.details = lines;
      o.totalQty = lines.reduce((sum, d) => sum + Number(d.qty), 0);
    }
  }

  /**
   * Load an order and authorize the caller. They must belong to the order's org;
   * beyond that, a reviewer (review_order) and admins may read any order in the
   * org, operations (process_order) may read any *locked* order, and a client
   * (place_order) may read only orders they placed.
   */
  async getOrder(userId: string, orderId: string) {
    const order = await this.orderRepo.findOne({ where: { id: orderId } });
    if (!order) throw new NotFoundException('Order not found');
    await this.orgService.assertOrgMembership(order.orgId, userId);

    const access = await this.resolveAccess(order.orgId, userId);
    const visible =
      access.canReview ||
      (access.canManage && order.locked) ||
      (access.canPlace && order.userId === userId);
    // 404 rather than 403 so a caller can't probe which orders exist.
    if (!visible) throw new NotFoundException('Order not found');

    return order;
  }

  /**
   * The order-detail read for the FE: the order plus its `details` (line items),
   * `totalQty` (their summed quantity), and `totalFee` — the running total the
   * client is charged (sum of every non-voided fee). Wraps {@link getOrder} for the
   * same authorization/scoping.
   */
  async getOrderDetail(userId: string, orderId: string) {
    const order = await this.getOrder(userId, orderId);
    const [details, totalFee] = await Promise.all([
      this.detailRepo.find({ where: { orderId: order.id }, order: { createdAt: 'ASC' } }),
      this.sumFees(order.id),
    ]);
    const totalQty = details.reduce((sum, d) => sum + d.qty, 0);
    return { ...order, details, totalQty, totalFee };
  }

  /** Sum of the non-voided fees charged against an order (0 when there are none). */
  private async sumFees(orderId: string): Promise<number> {
    const raw = await this.feeRepo
      .createQueryBuilder('fee')
      .select('COALESCE(SUM(fee.amount), 0)', 'sum')
      .where('fee.orderId = :orderId', { orderId })
      .andWhere('fee.voidedAt IS NULL')
      .getRawOne<{ sum: string }>();
    return parseFloat(raw?.sum ?? '0');
  }

  /**
   * Edit the order **header** — currently just its `tracking` reference. Same lock
   * gate as line edits (owner pre-lock, reviewer post-lock). Line changes go through
   * the /details routes, not here.
   */
  async updateOrder(userId: string, orderId: string, dto: UpdateOrderDto) {
    const order = await this.getOrder(userId, orderId);
    await this.assertEditable(order, userId);

    if (dto.tracking === order.tracking) {
      throw new BadRequestException('Nothing to update: tracking is unchanged');
    }

    return this.orderRepo.manager.transaction(async (em) => {
      const changes: OrderChange = {
        order: { tracking: { from: order.tracking, to: dto.tracking } },
      };
      order.tracking = dto.tracking;
      const saved = await em.save(order);
      await this.writeHistory(em, order.id, userId, OrderChangeType.ORDER_UPDATED, changes, null);
      return saved;
    });
  }

  /**
   * Add a line to an order. Same lock gate as {@link updateOrder}. The new line is
   * PENDING; `dto.name` is the client's free text, prefixed with the order client's
   * code. Writes an ITEM_ADDED history row (the new line's fields as to-only diffs).
   */
  async addDetail(userId: string, orderId: string, dto: AddOrderDetailDto) {
    const order = await this.getOrder(userId, orderId);
    await this.assertEditable(order, userId);

    return this.orderRepo.manager.transaction(async (em) => {
      const code = await this.ensureUserCode(em, order.userId);

      const detail = await em.save(
        em.create(OrderDetail, {
          orderId: order.id,
          name: this.composeName(code, dto.name),
          qty: dto.qty,
          note: dto.note ?? null,
          status: OrderDetailStatus.PENDING,
        }),
      );

      const changes: OrderChange = {
        item: this.itemChange(detail, {
          qty: { to: detail.qty },
          ...(detail.note !== null ? { note: { to: detail.note } } : {}),
        }),
      };
      // The line's own `note` is data (captured in `changes`), not an action note.
      await this.writeHistory(em, order.id, userId, OrderChangeType.ITEM_ADDED, changes, null);
      return detail;
    });
  }

  /**
   * Edit a line's name/qty/note (not its receipt status — that is the /status
   * route). Same lock gate as {@link updateOrder}. Writes an ITEM_UPDATED row whose
   * `changes.item.fields` carries a from/to for **only** the fields that changed.
   */
  async updateDetail(userId: string, orderId: string, detailId: string, dto: UpdateOrderDetailDto) {
    const order = await this.getOrder(userId, orderId);
    await this.assertEditable(order, userId);

    if (dto.name === undefined && dto.qty === undefined && dto.note === undefined) {
      throw new BadRequestException('Nothing to update');
    }

    const detail = await this.detailRepo.findOne({ where: { id: detailId, orderId: order.id } });
    if (!detail) throw new NotFoundException('Order line not found');
    if (detail.status === OrderDetailStatus.CANCELLED) {
      throw new BadRequestException('Cannot edit a cancelled line');
    }

    return this.orderRepo.manager.transaction(async (em) => {
      const code = await this.ensureUserCode(em, order.userId);

      // Diff only the fields that actually change.
      const fields: Record<string, FieldDiff> = {};
      if (dto.name !== undefined) {
        const newName = this.composeName(code, dto.name);
        if (newName !== detail.name) {
          fields.name = { from: detail.name, to: newName };
          detail.name = newName;
        }
      }
      if (dto.qty !== undefined && dto.qty !== detail.qty) {
        fields.qty = { from: detail.qty, to: dto.qty };
        detail.qty = dto.qty;
      }
      if (dto.note !== undefined && dto.note !== detail.note) {
        fields.note = { from: detail.note, to: dto.note };
        detail.note = dto.note;
      }
      if (Object.keys(fields).length === 0) {
        throw new BadRequestException('Nothing to update: the line is unchanged');
      }

      const saved = await em.save(detail);
      const changes: OrderChange = { item: this.itemChange(detail, fields) };
      await this.writeHistory(em, order.id, userId, OrderChangeType.ITEM_UPDATED, changes, null);
      return saved;
    });
  }

  /**
   * Remove a line from an order. Same lock gate as {@link updateOrder}. An order
   * must keep at least one line, so removing the last is rejected. Writes an
   * ITEM_REMOVED row snapshotting the line (with its qty as a from-only diff).
   */
  async removeDetail(userId: string, orderId: string, detailId: string) {
    const order = await this.getOrder(userId, orderId);
    await this.assertEditable(order, userId);

    const detail = await this.detailRepo.findOne({ where: { id: detailId, orderId: order.id } });
    if (!detail) throw new NotFoundException('Order line not found');

    const count = await this.detailRepo.count({ where: { orderId: order.id } });
    if (count <= 1) {
      throw new BadRequestException('An order must have at least one line');
    }

    return this.orderRepo.manager.transaction(async (em) => {
      const changes: OrderChange = {
        item: this.itemChange(detail, { qty: { from: detail.qty } }),
      };
      await em.remove(detail);
      await this.writeHistory(em, order.id, userId, OrderChangeType.ITEM_REMOVED, changes, null);
      return { id: detailId, removed: true };
    });
  }

  /**
   * Operations confirms a line's receipt outcome (RECEIVED → inventory, NOT_ARRIVED,
   * or CANCELLED). Only after the order is locked, only by `process_order`, and only
   * while the order is not terminal. Writes an ITEM_RECEIPT history row with the
   * line's status diff.
   */
  async updateDetailStatus(
    userId: string,
    orderId: string,
    detailId: string,
    dto: UpdateOrderDetailStatusDto,
  ) {
    const order = await this.getOrder(userId, orderId);
    if (!order.locked) {
      throw new BadRequestException('Line receipt can only be set after the order is locked');
    }
    const access = await this.resolveAccess(order.orgId, userId);
    if (!access.canManage) {
      throw new ForbiddenException("Only operations can set a line's receipt status");
    }
    if (TERMINAL_STATUSES.includes(order.status)) {
      throw new BadRequestException(`Cannot change a line on an order that is ${order.status}`);
    }

    const detail = await this.detailRepo.findOne({ where: { id: detailId, orderId: order.id } });
    if (!detail) throw new NotFoundException('Order line not found');

    if (dto.status === detail.status) {
      throw new BadRequestException(`Line is already ${detail.status}`);
    }
    if (!DETAIL_TRANSITIONS[detail.status].includes(dto.status)) {
      throw new BadRequestException(`Cannot move line from ${detail.status} to ${dto.status}`);
    }

    return this.orderRepo.manager.transaction(async (em) => {
      const prev = detail.status;
      detail.status = dto.status;
      const saved = await em.save(detail);

      const changes: OrderChange = {
        item: this.itemChange(detail, { status: { from: prev, to: dto.status } }),
      };
      await this.writeHistory(
        em,
        order.id,
        userId,
        OrderChangeType.ITEM_RECEIPT,
        changes,
        dto.note ?? null,
      );
      return saved;
    });
  }

  /**
   * A reviewer (`review_order`) reviews and locks a freshly placed (IN_TRANSIT)
   * order, handing it to operations. Locking freezes the client out of further edits
   * and surfaces the order into the operations (process_order) queue. Recorded as a
   * LOCKED history row. Only a still-in-transit, not-yet-locked order can be locked.
   *
   * Locking is also the billing event: the order's **client** (`order.userId`, not
   * the acting reviewer) is charged the org's flat `ORDER_LOCK` fee. The charge, the
   * lock, and both audit rows all happen in one transaction, and the client's row is
   * locked `FOR UPDATE` so concurrent charges can't overdraw. If the client's credit
   * can't cover the fee the whole lock is rejected. An org with no configured fee
   * charges nothing, but a (protected, non-voidable) `total_fees` row is always
   * written to record the lock fee — a zero amount when the org has none.
   */
  async lockOrder(userId: string, orderId: string, dto: LockOrderDto) {
    const order = await this.getOrder(userId, orderId);

    if (order.locked) {
      throw new BadRequestException('Order is already locked');
    }
    if (!PENDING_STATUSES.includes(order.status)) {
      throw new BadRequestException('Only an in-transit order can be reviewed and locked');
    }

    return this.orderRepo.manager.transaction(async (em) => {
      // The client who placed the order pays the lock fee — resolve the org's flat
      // ORDER_LOCK fee (0 if the org has none configured).
      const feeRow = await em.findOne(OrgFee, {
        where: { orgId: order.orgId, feeType: FeeType.ORDER_LOCK },
      });
      // The org's flat fee is the warehouse's base cut. If the client is in a credit
      // group, its fee overrides this as what the client pays; the group's owner earns
      // the difference (see resolveClientFee / creditCommission).
      const base = feeRow?.amount ?? 0;
      const { charged, ownerId } = await resolveClientFee(
        em,
        order.orgId,
        order.userId,
        FeeType.ORDER_LOCK,
        base,
      );

      // Always record the lock fee as a protected (non-voidable) row, so it shows up
      // in the order's fee list alongside any extra fees — even when it is 0.
      const lockFee = await em.save(
        em.create(TotalFee, {
          name: 'Order lock fee',
          amount: charged,
          isProtected: true,
          orgId: order.orgId,
          orderId: order.id,
          shipmentId: null,
          createdBy: userId,
          note: dto.note ?? null,
        }),
      );

      if (charged > 0) {
        // Lock the client's row so two concurrent locks can't both pass the check
        // and overdraw the balance.
        const rows: Array<{ credit: string }> = await em.query(
          `SELECT credit FROM wh.users WHERE id = $1 FOR UPDATE`,
          [order.userId],
        );
        if (rows.length === 0) throw new NotFoundException('Order client not found');

        const prevBalance = parseFloat(rows[0].credit);
        if (prevBalance < charged) {
          throw new BadRequestException('Client has insufficient credit to lock this order');
        }
        const newBalance = prevBalance - charged;

        await em.update(User, { id: order.userId }, { credit: newBalance });

        await em.save(
          em.create(CreditHistory, {
            userId: order.userId,
            orgId: order.orgId,
            entryType: CreditEntryType.ORDER_LOCK,
            amount: -charged,
            prevBalance,
            newBalance,
            orderId: order.id,
            feeId: lockFee.id,
            note: dto.note ?? null,
          }),
        );
      }

      // Credit the credit group's owner the markup they earned (group fee − org fee);
      // the warehouse keeps only the org base.
      const markup = charged - base;
      if (ownerId && markup > 0) {
        await creditCommission(em, {
          ownerId,
          orgId: order.orgId,
          amount: markup,
          orderId: order.id,
          feeId: lockFee.id,
          note: dto.note ?? null,
        });
      }

      order.locked = true;
      const saved = await em.save(order);

      // When and by whom it was locked are captured by this LOCKED history row
      // (its `createdAt` and `changedBy`).
      const changes: OrderChange = { order: { locked: { from: false, to: true } } };
      await this.writeHistory(
        em,
        order.id,
        userId,
        OrderChangeType.LOCKED,
        changes,
        dto.note ?? null,
      );

      return saved;
    });
  }

  /**
   * Move an order along its lifecycle, recording a STATUS_CHANGED. Who may move it,
   * and to where, depends on the lock gate:
   *   - while **unlocked**, only the owning client may change status — cancelling an
   *     in-transit order (CLIENT_TRANSITIONS);
   *   - once **locked**, the client is frozen out and only operations
   *     (`process_order`) drives the warehouse lifecycle (PROCESS_TRANSITIONS).
   */
  async updateStatus(userId: string, orderId: string, dto: UpdateOrderStatusDto) {
    const order = await this.getOrder(userId, orderId);

    let allowed: OrderStatus[];
    if (order.locked) {
      // Post-lock: operations territory; the client can no longer act.
      const access = await this.resolveAccess(order.orgId, userId);
      if (!access.canManage) {
        throw new ForbiddenException('Order is locked; only operations can change its status');
      }
      allowed = PROCESS_TRANSITIONS[order.status];
    } else {
      // Pre-lock: the client cancels an in-transit order.
      if (order.userId !== userId) {
        throw new ForbiddenException(
          'Only the client who placed the order can change its status before it is locked',
        );
      }
      allowed = CLIENT_TRANSITIONS[order.status];
    }

    if (dto.status === order.status) {
      throw new BadRequestException(`Order is already ${order.status}`);
    }
    if (!allowed.includes(dto.status)) {
      throw new BadRequestException(`Cannot move order from ${order.status} to ${dto.status}`);
    }

    return this.orderRepo.manager.transaction(async (em) => {
      const prevStatus = order.status;
      order.status = dto.status;
      const saved = await em.save(order);

      const changes: OrderChange = {
        order: { status: { from: prevStatus, to: dto.status } },
      };
      await this.writeHistory(
        em,
        order.id,
        userId,
        OrderChangeType.STATUS_CHANGED,
        changes,
        dto.note ?? null,
      );

      // Moving an order into the warehouse marks every still-pending line as
      // RECEIVED by default — the common case is that all declared goods arrived.
      // Operations can still correct individual lines to NOT_ARRIVED or CANCELLED
      // afterwards via PATCH /orders/:orderId/details/:detailId/status. Lines
      // already resolved (received/not-arrived/cancelled while locked) are left
      // untouched. Each auto-receipt is recorded as its own ITEM_RECEIPT row.
      if (dto.status === OrderStatus.IN_WAREHOUSE) {
        const pending = await em.find(OrderDetail, {
          where: { orderId: order.id, status: OrderDetailStatus.PENDING },
        });
        for (const detail of pending) {
          const prev = detail.status;
          detail.status = OrderDetailStatus.RECEIVED;
          await em.save(detail);

          const itemChanges: OrderChange = {
            item: this.itemChange(detail, {
              status: { from: prev, to: OrderDetailStatus.RECEIVED },
            }),
          };
          await this.writeHistory(
            em,
            order.id,
            userId,
            OrderChangeType.ITEM_RECEIPT,
            itemChanges,
            null,
          );
        }
      }

      return saved;
    });
  }

  /** An order's audit trail, newest first, keyset-paginated by (created_at, id). */
  async getHistory(
    userId: string,
    orderId: string,
    limitRaw?: string,
    cursor?: string,
  ): Promise<Page<OrderHistory>> {
    await this.getOrder(userId, orderId);

    const limit = parseLimit(limitRaw);
    const qb = this.historyRepo
      .createQueryBuilder('h')
      .leftJoin('h.changedByUser', 'u')
      .addSelect(['u.id', 'u.displayName', 'u.email', 'u.code'])
      .where('h.orderId = :orderId', { orderId })
      .orderBy('h.createdAt', 'DESC')
      .addOrderBy('h.id', 'DESC')
      .take(limit + 1);

    if (cursor) {
      const { t, id } = decodeCursor(cursor);
      qb.andWhere('(h.createdAt < :t OR (h.createdAt = :t AND h.id < :id))', {
        t: new Date(t),
        id,
      });
    }

    return toPage(await qb.getMany(), limit);
  }
}
