import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { EntityManager, Repository } from 'typeorm';
import { Order, OrderStatus } from '../entities/order.entity';
import { OrderChangeType, OrderHistory } from '../entities/order-history.entity';
import { Shipment, ShipmentStatus } from '../entities/shipment.entity';
import { ShipmentDetail } from '../entities/shipment-detail.entity';
import { ShipmentChangeType, ShipmentHistory } from '../entities/shipment-history.entity';
import { User } from '../entities/user.entity';
import { FeeType, OrgFee } from '../entities/org-fee.entity';
import { CreditEntryType, CreditHistory } from '../entities/credit-history.entity';
import { TotalFee } from '../entities/total-fee.entity';
import { OrganizationService } from '../organization/organization.service';
import { PlaceShipmentDto } from './dto/place-shipment.dto';
import { UpdateShipmentDto } from './dto/update-shipment.dto';
import { LockShipmentDto } from './dto/lock-shipment.dto';
import { UpdateShipmentStatusDto } from './dto/update-shipment-status.dto';
import { ShipmentItemDto } from './dto/shipment-item.dto';
import { decodeCursor, Page, parseLimit, toPage } from '../common/pagination.util';

/** Status moves the **client** (owner) may make while the shipment is unlocked. */
const CLIENT_SHIPMENT_TRANSITIONS: Record<ShipmentStatus, ShipmentStatus[]> = {
  [ShipmentStatus.REQUESTED]: [ShipmentStatus.CANCELLED],
  [ShipmentStatus.DELIVERED]: [],
  [ShipmentStatus.CANCELLED]: [],
};

/** Status moves **operations** (process_shipment) may make once the shipment is locked. */
const PROCESS_SHIPMENT_TRANSITIONS: Record<ShipmentStatus, ShipmentStatus[]> = {
  [ShipmentStatus.REQUESTED]: [ShipmentStatus.DELIVERED, ShipmentStatus.CANCELLED],
  [ShipmentStatus.DELIVERED]: [],
  [ShipmentStatus.CANCELLED]: [],
};

const SHIPMENT_STATUS_VALUES = new Set<string>(Object.values(ShipmentStatus));

/** Parse a comma-separated `status` query param into valid ShipmentStatus values. */
function parseStatuses(raw?: string): ShipmentStatus[] {
  if (!raw) return [];
  return raw
    .split(',')
    .map((s) => s.trim())
    .filter((s) => SHIPMENT_STATUS_VALUES.has(s)) as ShipmentStatus[];
}

/** Parse the optional `locked` query filter; undefined means "no filter". */
function parseLocked(raw?: string): boolean | undefined {
  if (raw === 'true') return true;
  if (raw === 'false') return false;
  return undefined;
}

/**
 * What the caller may see among an org's shipments, mirroring the three order
 * permissions (admins hold all). A user may hold several — they see the union.
 */
interface ShipmentAccess {
  /** review_shipment (or admin): sees every shipment in the org. */
  canReview: boolean;
  /** process_shipment: sees only locked shipments — the operations queue. */
  canManage: boolean;
  /** place_shipment: sees only the shipments they placed. */
  canPlace: boolean;
}

@Injectable()
export class ShipmentService {
  constructor(
    @InjectRepository(Shipment) private shipmentRepo: Repository<Shipment>,
    @InjectRepository(ShipmentHistory) private historyRepo: Repository<ShipmentHistory>,
    @InjectRepository(TotalFee) private feeRepo: Repository<TotalFee>,
    private readonly orgService: OrganizationService,
  ) {}

  /**
   * Place a shipment request into `dto.orgId` as the calling client: withdraw the
   * given quantities out of one or more of the caller's warehoused orders. The
   * shipment number is auto-generated per-(user, org) as `<user code>-S<6-digit seq>`.
   * Created as REQUESTED and unlocked; no stock is moved and no fee is charged until
   * a reviewer locks it. All in one transaction, so the number is never duplicated
   * and the shipment always has an opening CREATED history entry.
   */
  async placeShipment(userId: string, dto: PlaceShipmentDto) {
    const orgId = dto.orgId;
    await this.orgService.getOrganization(orgId);
    await this.orgService.assertOrgMembership(orgId, userId);

    return this.shipmentRepo.manager.transaction(async (em) => {
      // Validate the requested lines against the caller's warehoused orders.
      await this.validateItems(em, orgId, userId, dto.items);

      // Ensure the placing user has a client code, then bump the per-(user, org)
      // shipment counter atomically.
      const user = await em.findOne(User, { where: { id: userId } });
      if (!user) throw new NotFoundException('User not found');
      let code = user.code;
      if (!code) {
        code = await this.orgService.resolveUserCode(undefined, user.displayName ?? user.email);
        await em.update(User, { id: userId }, { code });
      }

      const rows: Array<{ next_seq: string }> = await em.query(
        `INSERT INTO wh.shipment_sequences (user_id_fk, org_id_fk, next_seq)
         VALUES ($1, $2, 1)
         ON CONFLICT (user_id_fk, org_id_fk)
           DO UPDATE SET next_seq = shipment_sequences.next_seq + 1
         RETURNING next_seq`,
        [userId, orgId],
      );
      const seq = Number(rows[0].next_seq);
      const shipmentNumber = `${code}-S${String(seq).padStart(6, '0')}`;

      const shipment = await em.save(
        em.create(Shipment, {
          shipmentNumber,
          orgId,
          userId,
          status: ShipmentStatus.REQUESTED,
          tracking: dto.tracking ?? null,
        }),
      );

      const items = await em.save(
        dto.items.map((item) =>
          em.create(ShipmentDetail, {
            shipmentId: shipment.id,
            orderId: item.orderId,
            qty: item.qty,
          }),
        ),
      );

      await em.save(
        em.create(ShipmentHistory, {
          shipmentId: shipment.id,
          changedBy: userId,
          changeType: ShipmentChangeType.CREATED,
          newStatus: ShipmentStatus.REQUESTED,
          newQty: totalQty(dto.items),
          note: dto.note ?? null,
        }),
      );

      shipment.items = items;
      return shipment;
    });
  }

  /**
   * Validate a shipment's requested lines: no duplicate orders, and every order is
   * one the caller placed, in `orgId`, IN_WAREHOUSE, with enough remaining qty. Used
   * by placement and edit (a soft check — the lock re-checks under a row lock).
   */
  private async validateItems(
    em: EntityManager,
    orgId: string,
    userId: string,
    items: ShipmentItemDto[],
  ): Promise<void> {
    const seen = new Set<string>();
    for (const item of items) {
      if (seen.has(item.orderId)) {
        throw new BadRequestException(`Order ${item.orderId} is listed more than once`);
      }
      seen.add(item.orderId);

      const order = await em.findOne(Order, { where: { id: item.orderId } });
      if (!order) throw new NotFoundException(`Order ${item.orderId} not found`);
      if (order.orgId !== orgId) {
        throw new BadRequestException(
          `Order ${order.orderNumber} does not belong to this organization`,
        );
      }
      if (order.userId !== userId) {
        throw new ForbiddenException(`You can only ship orders you placed (${order.orderNumber})`);
      }
      if (order.status !== OrderStatus.IN_WAREHOUSE) {
        throw new BadRequestException(
          `Order ${order.orderNumber} is not in the warehouse and cannot be shipped`,
        );
      }
      const remaining = order.qty - order.shippedQty;
      if (item.qty > remaining) {
        throw new BadRequestException(
          `Order ${order.orderNumber} has only ${remaining} left to ship (requested ${item.qty})`,
        );
      }
    }
  }

  /**
   * Resolve the caller's shipment-visibility across the three shipment permissions
   * (admins hold all). Used for row-level scoping by `listShipments`/`getShipment`.
   */
  private async resolveAccess(orgId: string, userId: string): Promise<ShipmentAccess> {
    const [canReview, canManage, canPlace] = await Promise.all([
      this.orgService.hasOrgPermission(orgId, userId, 'review_shipment'),
      this.orgService.hasOrgPermission(orgId, userId, 'process_shipment'),
      this.orgService.hasOrgPermission(orgId, userId, 'place_shipment'),
    ]);
    return { canReview, canManage, canPlace };
  }

  /**
   * List an org's shipments, newest first, keyset-paginated by (created_at, id).
   * Optional `status`, `search` (shipment number) and `locked` filters, same scoping
   * as orders: reviewers/admins see all, operations sees only locked, a client sees
   * only their own.
   */
  async listShipments(
    userId: string,
    orgId: string,
    limitRaw?: string,
    cursor?: string,
    statusRaw?: string,
    search?: string,
    lockedRaw?: string,
  ): Promise<Page<Shipment>> {
    await this.orgService.getOrganization(orgId);
    await this.orgService.assertOrgMembership(orgId, userId);

    const access = await this.resolveAccess(orgId, userId);

    const limit = parseLimit(limitRaw);
    const qb = this.shipmentRepo
      .createQueryBuilder('s')
      .where('s.orgId = :orgId', { orgId })
      .orderBy('s.createdAt', 'DESC')
      .addOrderBy('s.id', 'DESC')
      .take(limit + 1);

    if (!access.canReview) {
      const scopes: string[] = [];
      if (access.canManage) scopes.push('s.locked = true');
      if (access.canPlace) scopes.push('s.userId = :ownerId');
      qb.andWhere(scopes.length ? `(${scopes.join(' OR ')})` : 'false', { ownerId: userId });
    }

    const locked = parseLocked(lockedRaw);
    if (locked !== undefined) {
      qb.andWhere('s.locked = :locked', { locked });
    }

    const statuses = parseStatuses(statusRaw);
    if (statuses.length > 0) {
      qb.andWhere('s.status IN (:...statuses)', { statuses });
    }

    const term = search?.trim();
    if (term) {
      qb.andWhere('s.shipmentNumber ILIKE :term', { term: `%${term}%` });
    }

    if (cursor) {
      const { t, id } = decodeCursor(cursor);
      qb.andWhere('(s.createdAt < :t OR (s.createdAt = :t AND s.id < :id))', {
        t: new Date(t),
        id,
      });
    }

    const page = toPage(await qb.getMany(), limit);
    await this.attachItemSummary(page.items);
    return page;
  }

  /**
   * Populate each shipment's list-only `orderCount` / `totalQty` (how many orders it
   * draws from and their combined qty) in a single grouped query over the paginated
   * slice, so the list UI gets them without loading every line set.
   */
  private async attachItemSummary(shipments: Shipment[]): Promise<void> {
    if (shipments.length === 0) return;
    const ids = shipments.map((s) => s.id);
    const rows: Array<{ shipmentId: string; orderCount: string; totalQty: string }> =
      await this.shipmentRepo.manager
        .createQueryBuilder(ShipmentDetail, 'd')
        .select('d.shipmentId', 'shipmentId')
        .addSelect('COUNT(*)', 'orderCount')
        .addSelect('COALESCE(SUM(d.qty), 0)', 'totalQty')
        .where('d.shipmentId IN (:...ids)', { ids })
        .groupBy('d.shipmentId')
        .getRawMany();

    const summary = new Map(rows.map((r) => [r.shipmentId, r]));
    for (const s of shipments) {
      const row = summary.get(s.id);
      s.orderCount = row ? Number(row.orderCount) : 0;
      s.totalQty = row ? Number(row.totalQty) : 0;
    }
  }

  /**
   * Load a shipment (with its per-order line items) and authorize the caller: they
   * must belong to the org, and then a reviewer/admin sees any shipment, operations
   * any *locked* shipment, and a client only their own. 404 rather than 403 so a
   * caller can't probe which shipments exist.
   */
  async getShipment(userId: string, shipmentId: string) {
    const shipment = await this.shipmentRepo
      .createQueryBuilder('s')
      .leftJoinAndSelect('s.items', 'item')
      .leftJoin('item.order', 'o')
      .addSelect(['o.id', 'o.orderNumber', 'o.qty', 'o.shippedQty', 'o.status'])
      .where('s.id = :id', { id: shipmentId })
      .getOne();
    if (!shipment) throw new NotFoundException('Shipment not found');

    await this.orgService.assertOrgMembership(shipment.orgId, userId);

    const access = await this.resolveAccess(shipment.orgId, userId);
    const visible =
      access.canReview ||
      (access.canManage && shipment.locked) ||
      (access.canPlace && shipment.userId === userId);
    if (!visible) throw new NotFoundException('Shipment not found');

    return shipment;
  }

  /**
   * The shipment-detail read for the FE: the shipment (with its line items) plus
   * `totalFee`, the running total the client is charged — the sum of every non-voided
   * fee on it (the protected lock fee plus any active extra fees; voided fees are
   * refunded so excluded). Wraps {@link getShipment} for the same auth/scoping.
   */
  async getShipmentDetail(userId: string, shipmentId: string) {
    const shipment = await this.getShipment(userId, shipmentId);
    const totalFee = await this.sumFees(shipment.id);
    return { ...shipment, totalFee };
  }

  /** Sum of the non-voided fees charged against a shipment (0 when there are none). */
  private async sumFees(shipmentId: string): Promise<number> {
    const raw = await this.feeRepo
      .createQueryBuilder('fee')
      .select('COALESCE(SUM(fee.amount), 0)', 'sum')
      .where('fee.shipmentId = :shipmentId', { shipmentId })
      .andWhere('fee.voidedAt IS NULL')
      .getRawOne<{ sum: string }>();
    return parseFloat(raw?.sum ?? '0');
  }

  /**
   * Edit an unlocked (REQUESTED) shipment's line items and/or tracking. Only the
   * owning client may edit, and only before a reviewer locks it. Supplying `items`
   * replaces the entire line set. Records an ITEM_CHANGE history row.
   */
  async updateShipment(userId: string, shipmentId: string, dto: UpdateShipmentDto) {
    const shipment = await this.getShipment(userId, shipmentId);

    if (shipment.locked) {
      throw new ForbiddenException('Shipment is locked and can no longer be edited');
    }
    if (shipment.userId !== userId) {
      throw new ForbiddenException('Only the client who placed the shipment can edit it');
    }
    if (shipment.status !== ShipmentStatus.REQUESTED) {
      throw new BadRequestException('Only a requested shipment can be edited');
    }

    const itemsChanged = dto.items !== undefined;
    const trackingChanged = dto.tracking !== undefined && dto.tracking !== shipment.tracking;
    if (!itemsChanged && !trackingChanged) {
      throw new BadRequestException('Nothing to update: items and tracking are unchanged');
    }

    await this.shipmentRepo.manager.transaction(async (em) => {
      const prevQty = totalQty(shipment.items);

      if (dto.items) {
        await this.validateItems(em, shipment.orgId, userId, dto.items);
        // Replace the line set: drop the old rows, insert the new ones.
        await em.delete(ShipmentDetail, { shipmentId: shipment.id });
        await em.save(
          dto.items.map((item) =>
            em.create(ShipmentDetail, {
              shipmentId: shipment.id,
              orderId: item.orderId,
              qty: item.qty,
            }),
          ),
        );
      }
      if (trackingChanged) {
        shipment.tracking = dto.tracking as string;
        await em.save(shipment);
      }

      await em.save(
        em.create(ShipmentHistory, {
          shipmentId: shipment.id,
          changedBy: userId,
          changeType: ShipmentChangeType.ITEM_CHANGE,
          prevQty,
          newQty: dto.items ? totalQty(dto.items) : prevQty,
          note: dto.note ?? null,
        }),
      );
    });

    return this.getShipment(userId, shipment.id);
  }

  /**
   * A reviewer (`review_shipment`) reviews and locks a REQUESTED shipment, handing
   * it to operations. Locking is the billing + fulfilment event, all in one
   * transaction:
   *   - the shipment's **client** (`shipment.userId`) is charged the org's flat
   *     `SHIPMENT_LOCK` fee (row locked FOR UPDATE; rejected if credit can't
   *     cover it; an org with no fee configured is charged nothing);
   *   - each line's qty is added to its order's `shipped_qty` (each order row locked
   *     FOR UPDATE and re-checked so concurrent locks can't over-ship), and an order
   *     whose `shipped_qty` reaches its `qty` is moved to COMPLETED;
   *   - a LOCKED history row is written.
   */
  async lockShipment(userId: string, shipmentId: string, dto: LockShipmentDto) {
    const shipment = await this.getShipment(userId, shipmentId);

    if (shipment.locked) {
      throw new BadRequestException('Shipment is already locked');
    }
    if (shipment.status !== ShipmentStatus.REQUESTED) {
      throw new BadRequestException('Only a requested shipment can be reviewed and locked');
    }

    await this.shipmentRepo.manager.transaction(async (em) => {
      // 1. Charge the client the org's SHIPMENT_LOCK fee (0 if none configured).
      const feeRow = await em.findOne(OrgFee, {
        where: { orgId: shipment.orgId, feeType: FeeType.SHIPMENT_LOCK },
      });
      const fee = feeRow?.amount ?? 0;

      // Always record the lock fee as a protected (non-voidable) row, so it shows up
      // in the shipment's fee list alongside any extra fees — even when it is 0.
      const lockFee = await em.save(
        em.create(TotalFee, {
          name: 'Shipment lock fee',
          amount: fee,
          isProtected: true,
          orgId: shipment.orgId,
          orderId: null,
          shipmentId: shipment.id,
          createdBy: userId,
          note: dto.note ?? null,
        }),
      );

      if (fee > 0) {
        const rows: Array<{ credit: string }> = await em.query(
          `SELECT credit FROM wh.users WHERE id = $1 FOR UPDATE`,
          [shipment.userId],
        );
        if (rows.length === 0) throw new NotFoundException('Shipment client not found');

        const prevBalance = parseFloat(rows[0].credit);
        if (prevBalance < fee) {
          throw new BadRequestException('Client has insufficient credit to lock this shipment');
        }
        const newBalance = prevBalance - fee;

        await em.update(User, { id: shipment.userId }, { credit: newBalance });

        await em.save(
          em.create(CreditHistory, {
            userId: shipment.userId,
            orgId: shipment.orgId,
            entryType: CreditEntryType.SHIPMENT_LOCK,
            amount: -fee,
            prevBalance,
            newBalance,
            shipmentId: shipment.id,
            feeId: lockFee.id,
            note: dto.note ?? null,
          }),
        );
      }

      // 2. Deduct each line's qty from its order, completing fully-shipped orders.
      const items = await em.find(ShipmentDetail, { where: { shipmentId: shipment.id } });
      for (const item of items) {
        const order = await em
          .createQueryBuilder(Order, 'o')
          .setLock('pessimistic_write')
          .where('o.id = :id', { id: item.orderId })
          .getOne();
        if (!order) throw new NotFoundException(`Order ${item.orderId} not found`);
        if (order.status !== OrderStatus.IN_WAREHOUSE) {
          throw new BadRequestException(
            `Order ${order.orderNumber} is no longer in the warehouse and cannot be shipped`,
          );
        }
        const newShipped = order.shippedQty + item.qty;
        if (newShipped > order.qty) {
          throw new BadRequestException(
            `Order ${order.orderNumber} would be over-shipped (only ${
              order.qty - order.shippedQty
            } left)`,
          );
        }

        const prevStatus = order.status;
        order.shippedQty = newShipped;
        if (newShipped === order.qty) {
          order.status = OrderStatus.COMPLETED;
        }
        await em.save(order);

        if (order.status !== prevStatus) {
          await em.save(
            em.create(OrderHistory, {
              orderId: order.id,
              changedBy: userId,
              changeType: OrderChangeType.STATUS_CHANGE,
              prevStatus,
              newStatus: order.status,
              note: `Fully shipped by shipment ${shipment.shipmentNumber}`,
            }),
          );
        }
      }

      // 3. Lock the shipment and record it.
      shipment.locked = true;
      await em.save(shipment);

      await em.save(
        em.create(ShipmentHistory, {
          shipmentId: shipment.id,
          changedBy: userId,
          changeType: ShipmentChangeType.LOCKED,
          note: dto.note ?? null,
        }),
      );
    });

    return this.getShipment(userId, shipment.id);
  }

  /**
   * Move a shipment's status, recording a STATUS_CHANGE. Split by the lock gate:
   *   - while **unlocked**, only the owning client may act — cancelling a REQUESTED
   *     shipment (nothing was deducted, so nothing is restored);
   *   - once **locked**, only operations (`process_shipment`) may act — marking it
   *     DELIVERED, or CANCELLED (which returns the shipped qty to its orders,
   *     reverting any order it had completed back to IN_WAREHOUSE). The fee is not
   *     refunded.
   */
  async updateStatus(userId: string, shipmentId: string, dto: UpdateShipmentStatusDto) {
    const shipment = await this.getShipment(userId, shipmentId);

    let allowed: ShipmentStatus[];
    if (shipment.locked) {
      const access = await this.resolveAccess(shipment.orgId, userId);
      if (!access.canManage) {
        throw new ForbiddenException('Shipment is locked; only operations can change its status');
      }
      allowed = PROCESS_SHIPMENT_TRANSITIONS[shipment.status];
    } else {
      if (shipment.userId !== userId) {
        throw new ForbiddenException(
          'Only the client who placed the shipment can change its status before it is locked',
        );
      }
      allowed = CLIENT_SHIPMENT_TRANSITIONS[shipment.status];
    }

    if (dto.status === shipment.status) {
      throw new BadRequestException(`Shipment is already ${shipment.status}`);
    }
    if (!allowed.includes(dto.status)) {
      throw new BadRequestException(
        `Cannot move shipment from ${shipment.status} to ${dto.status}`,
      );
    }

    await this.shipmentRepo.manager.transaction(async (em) => {
      // Cancelling a locked shipment returns its committed qty to the orders.
      if (shipment.locked && dto.status === ShipmentStatus.CANCELLED) {
        await this.restoreShippedQty(em, shipment, userId);
      }

      const prevStatus = shipment.status;
      shipment.status = dto.status;
      await em.save(shipment);

      await em.save(
        em.create(ShipmentHistory, {
          shipmentId: shipment.id,
          changedBy: userId,
          changeType: ShipmentChangeType.STATUS_CHANGE,
          prevStatus,
          newStatus: dto.status,
          note: dto.note ?? null,
        }),
      );
    });

    return this.getShipment(userId, shipment.id);
  }

  /**
   * Reverse a locked shipment's stock deduction: subtract each line's qty back from
   * its order's `shipped_qty`, and revert any order this shipment had completed back
   * to IN_WAREHOUSE. Each order row is locked FOR UPDATE.
   */
  private async restoreShippedQty(em: EntityManager, shipment: Shipment, actorId: string) {
    const items = await em.find(ShipmentDetail, { where: { shipmentId: shipment.id } });
    for (const item of items) {
      const order = await em
        .createQueryBuilder(Order, 'o')
        .setLock('pessimistic_write')
        .where('o.id = :id', { id: item.orderId })
        .getOne();
      if (!order) continue;

      const prevStatus = order.status;
      order.shippedQty = Math.max(0, order.shippedQty - item.qty);
      if (order.status === OrderStatus.COMPLETED && order.shippedQty < order.qty) {
        order.status = OrderStatus.IN_WAREHOUSE;
      }
      await em.save(order);

      if (order.status !== prevStatus) {
        await em.save(
          em.create(OrderHistory, {
            orderId: order.id,
            changedBy: actorId,
            changeType: OrderChangeType.STATUS_CHANGE,
            prevStatus,
            newStatus: order.status,
            note: `Shipment ${shipment.shipmentNumber} cancelled`,
          }),
        );
      }
    }
  }

  /** A shipment's audit trail, oldest first, keyset-paginated by (created_at, id). */
  async getHistory(
    userId: string,
    shipmentId: string,
    limitRaw?: string,
    cursor?: string,
  ): Promise<Page<ShipmentHistory>> {
    await this.getShipment(userId, shipmentId);

    const limit = parseLimit(limitRaw);
    const qb = this.historyRepo
      .createQueryBuilder('h')
      .leftJoin('h.changedByUser', 'u')
      .addSelect(['u.id', 'u.displayName', 'u.email', 'u.code'])
      .where('h.shipmentId = :shipmentId', { shipmentId })
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

/** Total quantity across a set of shipment lines. */
function totalQty(items: Array<{ qty: number }>): number {
  return items.reduce((sum, item) => sum + item.qty, 0);
}
