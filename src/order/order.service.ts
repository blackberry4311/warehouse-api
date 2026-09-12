import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Order, OrderStatus } from '../entities/order.entity';
import { OrderChangeType, OrderHistory } from '../entities/order-history.entity';
import { User } from '../entities/user.entity';
import { FeeType, OrgFee } from '../entities/org-fee.entity';
import { CreditEntryType, CreditHistory } from '../entities/credit-history.entity';
import { OrganizationService } from '../organization/organization.service';
import { PlaceOrderDto } from './dto/place-order.dto';
import { UpdateOrderDto } from './dto/update-order.dto';
import { UpdateOrderStatusDto } from './dto/update-order-status.dto';
import { LockOrderDto } from './dto/lock-order.dto';
import { decodeCursor, Page, parseLimit, toPage } from '../common/pagination.util';

/**
 * Status moves the **client** (order owner) may make while the order is still
 * unlocked — reporting their shipment's progress between the two pending states,
 * or cancelling. Once a reviewer locks the order the client can no longer act.
 */
const CLIENT_TRANSITIONS: Record<OrderStatus, OrderStatus[]> = {
  [OrderStatus.SHIPPING]: [OrderStatus.ARRIVING, OrderStatus.CANCELLED],
  [OrderStatus.ARRIVING]: [OrderStatus.SHIPPING, OrderStatus.CANCELLED],
  [OrderStatus.IN_WAREHOUSE]: [],
  [OrderStatus.COMPLETED]: [],
  [OrderStatus.CANCELLED]: [],
};

/**
 * Status moves **operations** (manage_order) may make, once the order is locked:
 * the warehouse lifecycle. A manager can push a locked order forward from either
 * pending state into the warehouse, then on to completion. CANCELLED is reachable
 * from any live state; COMPLETED and CANCELLED are terminal.
 */
const MANAGE_TRANSITIONS: Record<OrderStatus, OrderStatus[]> = {
  [OrderStatus.SHIPPING]: [OrderStatus.ARRIVING, OrderStatus.IN_WAREHOUSE, OrderStatus.CANCELLED],
  [OrderStatus.ARRIVING]: [OrderStatus.IN_WAREHOUSE, OrderStatus.CANCELLED],
  [OrderStatus.IN_WAREHOUSE]: [OrderStatus.COMPLETED, OrderStatus.CANCELLED],
  [OrderStatus.COMPLETED]: [],
  [OrderStatus.CANCELLED]: [],
};

/** The two pending (pre-warehouse) states an order can be locked / edited in. */
const PENDING_STATUSES: readonly OrderStatus[] = [OrderStatus.SHIPPING, OrderStatus.ARRIVING];

/** Terminal states — no further transitions, no edits. */
const TERMINAL_STATUSES: readonly OrderStatus[] = [OrderStatus.COMPLETED, OrderStatus.CANCELLED];

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
  /** manage_order: sees only locked (reviewed) orders — the operations queue. */
  canManage: boolean;
  /** place_order: sees only the orders they placed. */
  canPlace: boolean;
}

@Injectable()
export class OrderService {
  constructor(
    @InjectRepository(Order) private orderRepo: Repository<Order>,
    @InjectRepository(OrderHistory) private historyRepo: Repository<OrderHistory>,
    private readonly orgService: OrganizationService,
  ) {}

  /**
   * Place a new order into `dto.orgId` as the calling client. Generates a
   * per-(user, org) order number, creates the order as SHIPPING (goods en route
   * by cargo ship), and writes a CREATED history row — all in one transaction so
   * the number is never a duplicate and an order always has an opening history entry.
   */
  async placeOrder(userId: string, dto: PlaceOrderDto) {
    const orgId = dto.orgId;
    await this.orgService.getOrganization(orgId);
    await this.orgService.assertOrgMembership(orgId, userId);

    return this.orderRepo.manager.transaction(async (em) => {
      // Ensure the placing user has a client code (self-registered users may not).
      const user = await em.findOne(User, { where: { id: userId } });
      if (!user) throw new NotFoundException('User not found');
      let code = user.code;
      if (!code) {
        code = await this.orgService.resolveUserCode(undefined, user.displayName ?? user.email);
        await em.update(User, { id: userId }, { code });
      }

      // Atomically bump the per-(user, org) counter.
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

      const status = dto.status ?? OrderStatus.SHIPPING;
      const order = await em.save(
        em.create(Order, {
          orderNumber,
          orgId,
          userId,
          qty: dto.qty,
          status,
        }),
      );

      await em.save(
        em.create(OrderHistory, {
          orderId: order.id,
          changedBy: userId,
          changeType: OrderChangeType.CREATED,
          newStatus: status,
          newQty: dto.qty,
          note: dto.note ?? null,
        }),
      );

      return order;
    });
  }

  /**
   * Resolve the caller's order-visibility across the three order permissions
   * (admins hold all). Used for row-level scoping by `listOrders` and `getOrder`.
   */
  private async resolveAccess(orgId: string, userId: string): Promise<OrderAccess> {
    const [canReview, canManage, canPlace] = await Promise.all([
      this.orgService.hasOrgPermission(orgId, userId, 'review_order'),
      this.orgService.hasOrgPermission(orgId, userId, 'manage_order'),
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
    // operations (manage_order), their own orders for a client (place_order).
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

    return toPage(await qb.getMany(), limit);
  }

  /**
   * Load an order and authorize the caller. They must belong to the order's org;
   * beyond that, a reviewer (review_order) and admins may read any order in the
   * org, operations (manage_order) may read any *locked* order, and a client
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
   * Edit an order's quantity, recording a QTY_CHANGE. Who may edit depends on the
   * lock gate:
   *   - while **unlocked**, only the owning client may edit, and only while the
   *     order is still in a pending (SHIPPING/ARRIVING) state;
   *   - once **locked**, the client is frozen out and only a reviewer
   *     (`review_order`) may edit, up until the order reaches a terminal state.
   */
  async updateOrder(userId: string, orderId: string, dto: UpdateOrderDto) {
    const order = await this.getOrder(userId, orderId);

    if (order.locked) {
      const access = await this.resolveAccess(order.orgId, userId);
      if (!access.canReview) {
        throw new ForbiddenException('Order is locked; only a reviewer can edit it');
      }
      if (TERMINAL_STATUSES.includes(order.status)) {
        throw new BadRequestException(`Cannot edit an order that is ${order.status}`);
      }
    } else {
      if (order.userId !== userId) {
        throw new ForbiddenException('Only the client who placed the order can edit it');
      }
      if (!PENDING_STATUSES.includes(order.status)) {
        throw new BadRequestException('Order can only be edited while shipping or arriving');
      }
    }
    if (dto.qty === order.qty) {
      throw new BadRequestException(`Quantity is already ${order.qty}`);
    }

    return this.orderRepo.manager.transaction(async (em) => {
      const prevQty = order.qty;
      order.qty = dto.qty;
      const saved = await em.save(order);

      await em.save(
        em.create(OrderHistory, {
          orderId: order.id,
          changedBy: userId,
          changeType: OrderChangeType.QTY_CHANGE,
          prevQty,
          newQty: dto.qty,
          note: dto.note ?? null,
        }),
      );

      return saved;
    });
  }

  /**
   * A reviewer (`review_order`) reviews and locks a freshly placed order, handing
   * it to operations. Locking freezes the client out of further edits and surfaces
   * the order into the operations (manage_order) queue. Recorded as a LOCKED
   * history row. Only a still-pending, not-yet-locked order can be locked.
   *
   * Locking is also the billing event: the order's **client** (`order.userId`, not
   * the acting reviewer) is charged the org's flat `ORDER_LOCK` fee. The charge, the
   * lock, and both audit rows all happen in one transaction, and the client's row is
   * locked `FOR UPDATE` so concurrent charges can't overdraw. If the client's credit
   * can't cover the fee the whole lock is rejected. An org with no configured fee is
   * charged nothing (and no ledger row is written).
   */
  async lockOrder(userId: string, orderId: string, dto: LockOrderDto) {
    const order = await this.getOrder(userId, orderId);

    if (order.locked) {
      throw new BadRequestException('Order is already locked');
    }
    if (!PENDING_STATUSES.includes(order.status)) {
      throw new BadRequestException('Only a shipping or arriving order can be reviewed and locked');
    }

    return this.orderRepo.manager.transaction(async (em) => {
      // The client who placed the order pays the lock fee — resolve the org's flat
      // ORDER_LOCK fee (0 if the org has none configured).
      const feeRow = await em.findOne(OrgFee, {
        where: { orgId: order.orgId, feeType: FeeType.ORDER_LOCK },
      });
      const fee = feeRow?.amount ?? 0;

      if (fee > 0) {
        // Lock the client's row so two concurrent locks can't both pass the check
        // and overdraw the balance.
        const rows: Array<{ credit: string }> = await em.query(
          `SELECT credit FROM wh.users WHERE id = $1 FOR UPDATE`,
          [order.userId],
        );
        if (rows.length === 0) throw new NotFoundException('Order client not found');

        const prevBalance = parseFloat(rows[0].credit);
        if (prevBalance < fee) {
          throw new BadRequestException('Client has insufficient credit to lock this order');
        }
        const newBalance = prevBalance - fee;

        await em.update(User, { id: order.userId }, { credit: newBalance });

        await em.save(
          em.create(CreditHistory, {
            userId: order.userId,
            orgId: order.orgId,
            entryType: CreditEntryType.ORDER_LOCK,
            amount: -fee,
            prevBalance,
            newBalance,
            orderId: order.id,
            note: dto.note ?? null,
          }),
        );
      }

      order.locked = true;
      order.lockedAt = new Date();
      order.lockedBy = userId;
      const saved = await em.save(order);

      await em.save(
        em.create(OrderHistory, {
          orderId: order.id,
          changedBy: userId,
          changeType: OrderChangeType.LOCKED,
          note: dto.note ?? null,
        }),
      );

      return saved;
    });
  }

  /**
   * Move an order along its lifecycle, recording a STATUS_CHANGE. Who may move it,
   * and to where, depends on the lock gate:
   *   - while **unlocked**, only the owning client may change status — reporting
   *     their shipment (SHIPPING ↔ ARRIVING) or cancelling (CLIENT_TRANSITIONS);
   *   - once **locked**, the client is frozen out and only operations
   *     (`manage_order`) drives the warehouse lifecycle (MANAGE_TRANSITIONS).
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
      allowed = MANAGE_TRANSITIONS[order.status];
    } else {
      // Pre-lock: the client reports shipment progress or cancels.
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

      await em.save(
        em.create(OrderHistory, {
          orderId: order.id,
          changedBy: userId,
          changeType: OrderChangeType.STATUS_CHANGE,
          prevStatus,
          newStatus: dto.status,
          note: dto.note ?? null,
        }),
      );

      return saved;
    });
  }

  /** An order's audit trail, oldest first, keyset-paginated by (created_at, id). */
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
      // Join the changing user so the FE can render who made each change. Select
      // only safe columns — never password_hash.
      .leftJoin('h.changedByUser', 'u')
      .addSelect(['u.id', 'u.displayName', 'u.email', 'u.code'])
      .where('h.orderId = :orderId', { orderId })
      .orderBy('h.createdAt', 'ASC')
      .addOrderBy('h.id', 'ASC')
      .take(limit + 1);

    if (cursor) {
      const { t, id } = decodeCursor(cursor);
      qb.andWhere('(h.createdAt > :t OR (h.createdAt = :t AND h.id > :id))', {
        t: new Date(t),
        id,
      });
    }

    return toPage(await qb.getMany(), limit);
  }
}
