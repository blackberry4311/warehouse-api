import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Order, OrderStatus } from '../entities/order.entity';
import { Shipment, ShipmentStatus } from '../entities/shipment.entity';
import { TotalFee } from '../entities/total-fee.entity';
import { CreditEntryType, CreditHistory } from '../entities/credit-history.entity';
import { User } from '../entities/user.entity';
import { OrganizationService } from '../organization/organization.service';
import { CreateExtraFeeDto } from './dto/create-extra-fee.dto';
import { decodeCursor, Page, parseLimit, toPage } from '../common/pagination.util';

/** Order states in which no further fee may be added (matches OrderService). */
const ORDER_TERMINAL: readonly OrderStatus[] = [OrderStatus.CANCELLED];

/**
 * A normalized view of the order/shipment a fee hangs off, so one set of
 * charge/list/void routines serves both flows. `perms` are the three role
 * permissions for the resource (client / reviewer / operations); `column` is the
 * `total_fees` FK that points at this target.
 */
interface FeeTarget {
  kind: 'order' | 'shipment';
  id: string;
  orgId: string;
  /** The client who placed it — the one charged. */
  clientUserId: string;
  locked: boolean;
  /** Whether a fee may still be added: locked and not yet in a terminal state. */
  chargeable: boolean;
  column: 'orderId' | 'shipmentId';
  perms: { review: string; process: string; place: string };
}

/** What the caller may do with a target's fees (admins hold every permission). */
interface FeeAccess {
  canReview: boolean;
  canManage: boolean;
  canPlace: boolean;
}

@Injectable()
export class ExtraFeeService {
  constructor(
    @InjectRepository(TotalFee) private feeRepo: Repository<TotalFee>,
    @InjectRepository(Order) private orderRepo: Repository<Order>,
    @InjectRepository(Shipment) private shipmentRepo: Repository<Shipment>,
    private readonly orgService: OrganizationService,
  ) {}

  // ----- Order fees -------------------------------------------------------

  async addOrderFee(actorId: string, orderId: string, dto: CreateExtraFeeDto) {
    return this.createFee(actorId, await this.resolveOrderTarget(orderId), dto);
  }

  async listOrderFees(actorId: string, orderId: string, limit?: string, cursor?: string) {
    return this.listFees(actorId, await this.resolveOrderTarget(orderId), limit, cursor);
  }

  async voidOrderFee(actorId: string, orderId: string, feeId: string, note?: string) {
    return this.voidFee(actorId, await this.resolveOrderTarget(orderId), feeId, note);
  }

  // ----- Shipment fees ----------------------------------------------------

  async addShipmentFee(actorId: string, shipmentId: string, dto: CreateExtraFeeDto) {
    return this.createFee(actorId, await this.resolveShipmentTarget(shipmentId), dto);
  }

  async listShipmentFees(actorId: string, shipmentId: string, limit?: string, cursor?: string) {
    return this.listFees(actorId, await this.resolveShipmentTarget(shipmentId), limit, cursor);
  }

  async voidShipmentFee(actorId: string, shipmentId: string, feeId: string, note?: string) {
    return this.voidFee(actorId, await this.resolveShipmentTarget(shipmentId), feeId, note);
  }

  // ----- Target resolution ------------------------------------------------

  private async resolveOrderTarget(orderId: string): Promise<FeeTarget> {
    const order = await this.orderRepo.findOne({ where: { id: orderId } });
    if (!order) throw new NotFoundException('Order not found');
    return {
      kind: 'order',
      id: order.id,
      orgId: order.orgId,
      clientUserId: order.userId,
      locked: order.locked,
      chargeable: order.locked && !ORDER_TERMINAL.includes(order.status),
      column: 'orderId',
      perms: { review: 'review_order', process: 'process_order', place: 'place_order' },
    };
  }

  private async resolveShipmentTarget(shipmentId: string): Promise<FeeTarget> {
    const shipment = await this.shipmentRepo.findOne({ where: { id: shipmentId } });
    if (!shipment) throw new NotFoundException('Shipment not found');
    return {
      kind: 'shipment',
      id: shipment.id,
      orgId: shipment.orgId,
      clientUserId: shipment.userId,
      locked: shipment.locked,
      // AWAITING is the only non-terminal shipment state; it stays AWAITING while locked.
      chargeable: shipment.locked && shipment.status === ShipmentStatus.AWAITING,
      column: 'shipmentId',
      perms: { review: 'review_shipment', process: 'process_shipment', place: 'place_shipment' },
    };
  }

  private async resolveAccess(target: FeeTarget, userId: string): Promise<FeeAccess> {
    const [canReview, canManage, canPlace] = await Promise.all([
      this.orgService.hasOrgPermission(target.orgId, userId, target.perms.review),
      this.orgService.hasOrgPermission(target.orgId, userId, target.perms.process),
      this.orgService.hasOrgPermission(target.orgId, userId, target.perms.place),
    ]);
    return { canReview, canManage, canPlace };
  }

  // ----- Shared operations ------------------------------------------------

  /**
   * Add a fee and charge the target's client in one transaction. Only a reviewer
   * or operations (the two staff roles) may add one, and only while the target is
   * locked and not terminal. The client's row is locked `FOR UPDATE` so concurrent
   * charges can't overdraw; insufficient credit is a 400.
   */
  private async createFee(actorId: string, target: FeeTarget, dto: CreateExtraFeeDto) {
    await this.orgService.assertOrgMembership(target.orgId, actorId);

    const access = await this.resolveAccess(target, actorId);
    if (!access.canReview && !access.canManage) {
      throw new ForbiddenException('Only a reviewer or operations staff can add a fee');
    }
    if (!target.chargeable) {
      throw new BadRequestException(
        `A fee can only be added to a locked, in-progress ${target.kind}`,
      );
    }

    return this.feeRepo.manager.transaction(async (em) => {
      const rows: Array<{ credit: string }> = await em.query(
        `SELECT credit FROM wh.users WHERE id = $1 FOR UPDATE`,
        [target.clientUserId],
      );
      if (rows.length === 0) throw new NotFoundException(`${target.kind} client not found`);

      const prevBalance = parseFloat(rows[0].credit);
      if (prevBalance < dto.amount) {
        throw new BadRequestException('Client has insufficient credit for this fee');
      }
      const newBalance = prevBalance - dto.amount;
      await em.update(User, { id: target.clientUserId }, { credit: newBalance });

      const fee = await em.save(
        em.create(TotalFee, {
          name: dto.name,
          amount: dto.amount,
          // A staff-added extra fee — voidable, unlike the protected lock fee.
          isProtected: false,
          orgId: target.orgId,
          orderId: target.column === 'orderId' ? target.id : null,
          shipmentId: target.column === 'shipmentId' ? target.id : null,
          createdBy: actorId,
          note: dto.note ?? null,
        }),
      );

      await em.save(
        em.create(CreditHistory, {
          userId: target.clientUserId,
          orgId: target.orgId,
          entryType: CreditEntryType.EXTRA_FEE,
          amount: -dto.amount,
          prevBalance,
          newBalance,
          orderId: fee.orderId,
          shipmentId: fee.shipmentId,
          feeId: fee.id,
          note: dto.note ?? null,
        }),
      );

      return fee;
    });
  }

  /**
   * List **every** fee charged against a target, newest first, keyset-paginated by
   * (created_at, id). One table holds both kinds: the protected lock fee
   * (`is_protected = true`, written at lock) and every ad-hoc extra fee
   * (`is_protected = false`), so this is a single query with no read-time merge.
   *
   * Same visibility as reading the order/shipment itself: a reviewer/admin sees all,
   * operations sees fees on locked targets, and the client sees fees on their own —
   * so a client can review what they were charged. 404 (not 403) when the caller
   * can't see the target, so they can't probe which exist.
   */
  private async listFees(
    actorId: string,
    target: FeeTarget,
    limitRaw?: string,
    cursor?: string,
  ): Promise<Page<TotalFee>> {
    await this.orgService.assertOrgMembership(target.orgId, actorId);

    const access = await this.resolveAccess(target, actorId);
    const visible =
      access.canReview ||
      (access.canManage && target.locked) ||
      (access.canPlace && target.clientUserId === actorId);
    if (!visible) throw new NotFoundException(`${target.kind} not found`);

    const limit = parseLimit(limitRaw);
    const qb = this.feeRepo
      .createQueryBuilder('fee')
      .leftJoin('fee.createdByUser', 'cu')
      .addSelect(['cu.id', 'cu.displayName', 'cu.email', 'cu.code'])
      .leftJoin('fee.voidedByUser', 'vu')
      .addSelect(['vu.id', 'vu.displayName', 'vu.email', 'vu.code'])
      .where(`fee.${target.column} = :targetId`, { targetId: target.id })
      .orderBy('fee.createdAt', 'DESC')
      .addOrderBy('fee.id', 'DESC')
      .take(limit + 1);

    if (cursor) {
      const { t, id } = decodeCursor(cursor);
      qb.andWhere('(fee.createdAt < :t OR (fee.createdAt = :t AND fee.id < :curId))', {
        t: new Date(t),
        curId: id,
      });
    }

    return toPage(await qb.getMany(), limit);
  }

  /**
   * Void a fee: refund the client and stamp the row, in one transaction. The fee
   * row is immutable — voiding writes a reversing `EXTRA_FEE` (+amount) ledger row
   * rather than deleting anything, so the ledger stays append-only and per-org
   * earnings net out. Only a reviewer or operations may void; the protected lock
   * fee (`is_protected`) can't be voided, and an already-voided fee is a 400.
   */
  private async voidFee(actorId: string, target: FeeTarget, feeId: string, note?: string) {
    await this.orgService.assertOrgMembership(target.orgId, actorId);

    const access = await this.resolveAccess(target, actorId);
    if (!access.canReview && !access.canManage) {
      throw new ForbiddenException('Only a reviewer or operations staff can void a fee');
    }

    return this.feeRepo.manager.transaction(async (em) => {
      const fee = await em.findOne(TotalFee, {
        where: { id: feeId, [target.column]: target.id },
      });
      if (!fee) throw new NotFoundException('Fee not found');
      if (fee.isProtected) throw new BadRequestException('The lock fee cannot be voided');
      if (fee.voidedAt) throw new BadRequestException('Fee is already voided');

      const rows: Array<{ credit: string }> = await em.query(
        `SELECT credit FROM wh.users WHERE id = $1 FOR UPDATE`,
        [target.clientUserId],
      );
      if (rows.length === 0) throw new NotFoundException(`${target.kind} client not found`);

      const prevBalance = parseFloat(rows[0].credit);
      const newBalance = prevBalance + fee.amount;
      await em.update(User, { id: target.clientUserId }, { credit: newBalance });

      fee.voidedAt = new Date();
      fee.voidedBy = actorId;
      const saved = await em.save(fee);

      await em.save(
        em.create(CreditHistory, {
          userId: target.clientUserId,
          orgId: target.orgId,
          entryType: CreditEntryType.EXTRA_FEE,
          amount: fee.amount,
          prevBalance,
          newBalance,
          orderId: fee.orderId,
          shipmentId: fee.shipmentId,
          feeId: fee.id,
          note: note ?? `Void of fee "${fee.name}"`,
        }),
      );

      return saved;
    });
  }
}
