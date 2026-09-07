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
import { OrganizationService } from '../organization/organization.service';
import { PlaceOrderDto } from './dto/place-order.dto';
import { UpdateOrderDto } from './dto/update-order.dto';
import { UpdateOrderStatusDto } from './dto/update-order-status.dto';
import { decodeCursor, Page, parseLimit, toPage } from './pagination.util';

/** Valid status moves. Operation (manage_order) drives these transitions. */
const ALLOWED_TRANSITIONS: Record<OrderStatus, OrderStatus[]> = {
  [OrderStatus.PENDING]: [OrderStatus.IN_WAREHOUSE, OrderStatus.CANCELLED],
  [OrderStatus.IN_WAREHOUSE]: [
    OrderStatus.PROCESSING,
    OrderStatus.COMPLETED,
    OrderStatus.CANCELLED,
  ],
  [OrderStatus.PROCESSING]: [OrderStatus.COMPLETED, OrderStatus.CANCELLED],
  [OrderStatus.COMPLETED]: [],
  [OrderStatus.CANCELLED]: [],
};

const ORDER_STATUS_VALUES = new Set<string>(Object.values(OrderStatus));

/** Parse a comma-separated `status` query param into valid OrderStatus values. */
function parseStatuses(raw?: string): OrderStatus[] {
  if (!raw) return [];
  return raw
    .split(',')
    .map((s) => s.trim())
    .filter((s) => ORDER_STATUS_VALUES.has(s)) as OrderStatus[];
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
   * per-(user, org) order number, creates the order as PENDING, and writes a
   * CREATED history row — all in one transaction so the number is never a
   * duplicate and an order always has an opening history entry.
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

      const order = await em.save(
        em.create(Order, {
          orderNumber,
          orgId,
          userId,
          qty: dto.qty,
          status: OrderStatus.PENDING,
        }),
      );

      await em.save(
        em.create(OrderHistory, {
          orderId: order.id,
          changedBy: userId,
          changeType: OrderChangeType.CREATED,
          newStatus: OrderStatus.PENDING,
          newQty: dto.qty,
          note: dto.note ?? null,
        }),
      );

      return order;
    });
  }

  /**
   * List an org's orders, newest first, keyset-paginated by (created_at, id).
   * Optional filters — `status` (any of a comma-separated list) and `search`
   * (order number, case-insensitive substring) — narrow the result and are
   * compatible with the cursor, since neither changes the ordering.
   */
  async listOrders(
    userId: string,
    orgId: string,
    limitRaw?: string,
    cursor?: string,
    statusRaw?: string,
    search?: string,
  ): Promise<Page<Order>> {
    await this.orgService.getOrganization(orgId);
    await this.orgService.assertOrgMembership(orgId, userId);

    // Operations (manage_order) and admins see every order in the org; a plain
    // client (place_order) sees only the orders they placed.
    const canManage = await this.orgService.hasOrgPermission(orgId, userId, 'manage_order');

    const limit = parseLimit(limitRaw);
    const qb = this.orderRepo
      .createQueryBuilder('order')
      .where('order.orgId = :orgId', { orgId })
      .orderBy('order.createdAt', 'DESC')
      .addOrderBy('order.id', 'DESC')
      .take(limit + 1);

    if (!canManage) {
      qb.andWhere('order.userId = :userId', { userId });
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
   * beyond that, operations (manage_order) and admins may read any order in the
   * org, while a plain client (place_order) may only read orders they placed.
   */
  async getOrder(userId: string, orderId: string) {
    const order = await this.orderRepo.findOne({ where: { id: orderId } });
    if (!order) throw new NotFoundException('Order not found');
    await this.orgService.assertOrgMembership(order.orgId, userId);

    if (order.userId !== userId) {
      const canManage = await this.orgService.hasOrgPermission(
        order.orgId,
        userId,
        'manage_order',
      );
      // 404 rather than 403 so a non-manager can't probe which orders exist.
      if (!canManage) throw new NotFoundException('Order not found');
    }

    return order;
  }

  /**
   * The client who placed an order edits it (quantity), recording a QTY_CHANGE.
   * Only the owner may edit, and only while the order is still PENDING — once it
   * reaches the warehouse the quantity is locked.
   */
  async updateOrder(userId: string, orderId: string, dto: UpdateOrderDto) {
    const order = await this.getOrder(userId, orderId);

    if (order.userId !== userId) {
      throw new ForbiddenException('Only the client who placed the order can edit it');
    }
    if (order.status !== OrderStatus.PENDING) {
      throw new BadRequestException('Order can only be edited while pending');
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

  /** Operation moves an order along its lifecycle, recording a STATUS_CHANGE. */
  async updateStatus(userId: string, orderId: string, dto: UpdateOrderStatusDto) {
    const order = await this.getOrder(userId, orderId);

    if (dto.status === order.status) {
      throw new BadRequestException(`Order is already ${order.status}`);
    }
    if (!ALLOWED_TRANSITIONS[order.status].includes(dto.status)) {
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
