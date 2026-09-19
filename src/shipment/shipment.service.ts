import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { EntityManager, Repository } from 'typeorm';
import { OrderDetail, OrderDetailStatus } from '../entities/order-detail.entity';
import { Shipment, ShipmentStatus } from '../entities/shipment.entity';
import { ShipmentDetail } from '../entities/shipment-detail.entity';
import { ShipmentLabel } from '../entities/shipment-label.entity';
import {
  ShipmentChange,
  ShipmentChangeType,
  ShipmentHistory,
  ShipmentItemChange,
} from '../entities/shipment-history.entity';
import { FieldDiff } from '../entities/order-history.entity';
import { User } from '../entities/user.entity';
import { FeeType, OrgFee } from '../entities/org-fee.entity';
import { CreditEntryType, CreditHistory } from '../entities/credit-history.entity';
import { TotalFee } from '../entities/total-fee.entity';
import { OrganizationService } from '../organization/organization.service';
import { StorageService } from '../storage/storage.service';
import { UploadedFile } from '../common/uploaded-file.util';
import { LABEL_URL_TTL_SECONDS } from '../common/shipment-label.util';
import { PlaceShipmentDto } from './dto/place-shipment.dto';
import { UpdateShipmentDto } from './dto/update-shipment.dto';
import { LockShipmentDto } from './dto/lock-shipment.dto';
import { UpdateShipmentStatusDto } from './dto/update-shipment-status.dto';
import { ShipmentItemDto } from './dto/shipment-item.dto';
import { decodeCursor, Page, parseLimit, toPage } from '../common/pagination.util';

/** Status moves the **client** (owner) may make while the shipment is unlocked. */
const CLIENT_SHIPMENT_TRANSITIONS: Record<ShipmentStatus, ShipmentStatus[]> = {
  [ShipmentStatus.AWAITING]: [ShipmentStatus.CANCELLED],
  [ShipmentStatus.DONE]: [],
  [ShipmentStatus.CANCELLED]: [],
};

/** Status moves **operations** (process_shipment) may make once the shipment is locked. */
const PROCESS_SHIPMENT_TRANSITIONS: Record<ShipmentStatus, ShipmentStatus[]> = {
  [ShipmentStatus.AWAITING]: [ShipmentStatus.DONE, ShipmentStatus.CANCELLED],
  [ShipmentStatus.DONE]: [],
  [ShipmentStatus.CANCELLED]: [],
};

/** Terminal shipment states — a label is useless once here, so the cleanup drops it. */
const SHIPMENT_TERMINAL_STATUSES: readonly ShipmentStatus[] = [
  ShipmentStatus.DONE,
  ShipmentStatus.CANCELLED,
];

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
    @InjectRepository(ShipmentLabel) private labelRepo: Repository<ShipmentLabel>,
    private readonly orgService: OrganizationService,
    private readonly storage: StorageService,
  ) {}

  /**
   * Place a shipment request into `dto.orgId` as the calling client: withdraw the
   * given quantities out of one or more of the caller's warehoused order line items. The
   * shipment number is auto-generated per-(user, org) as `<user code>-S<6-digit seq>`.
   * Created as AWAITING and unlocked; no stock is moved and no fee is charged until
   * a reviewer locks it. All in one transaction, so the number is never duplicated
   * and the shipment always has an opening CREATED history entry.
   */
  async placeShipment(userId: string, dto: PlaceShipmentDto) {
    const orgId = dto.orgId;
    await this.orgService.getOrganization(orgId);
    await this.orgService.assertOrgMembership(orgId, userId);

    return this.shipmentRepo.manager.transaction(async (em) => {
      // Validate the requested lines against the caller's warehoused orders.
      const details = await this.validateItems(em, orgId, userId, dto.items);

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
          status: ShipmentStatus.AWAITING,
        }),
      );

      const items = await em.save(
        dto.items.map((item) =>
          em.create(ShipmentDetail, {
            shipmentId: shipment.id,
            orderDetailId: item.orderDetailId,
            qty: item.qty,
          }),
        ),
      );

      // CREATED snapshots the header status and every line (to-only diffs).
      const changes: ShipmentChange = {
        shipment: { status: { to: ShipmentStatus.AWAITING } },
        items: dto.items.map((item) =>
          this.shipmentItemChange(details.get(item.orderDetailId)!, { qty: { to: item.qty } }),
        ),
      };
      await this.writeHistory(
        em,
        shipment.id,
        userId,
        ShipmentChangeType.CREATED,
        changes,
        dto.note ?? null,
      );

      shipment.items = items;
      return shipment;
    });
  }

  /**
   * Validate a shipment's requested lines: no duplicate line items, and every line is
   * one the caller placed (its order is theirs), in `orgId`, RECEIVED (warehoused
   * inventory), with enough remaining qty (`qty - shipped_qty`). Used by placement and
   * edit (a soft check — the lock re-checks each line under a row lock). Returns the
   * loaded `order_details` (with their order), keyed by id, so the caller can snapshot
   * line names / order numbers into the history payload without re-querying.
   */
  private async validateItems(
    em: EntityManager,
    orgId: string,
    userId: string,
    items: ShipmentItemDto[],
  ): Promise<Map<string, OrderDetail>> {
    const details = new Map<string, OrderDetail>();
    for (const item of items) {
      if (details.has(item.orderDetailId)) {
        throw new BadRequestException(`Line item ${item.orderDetailId} is listed more than once`);
      }

      const detail = await em.findOne(OrderDetail, {
        where: { id: item.orderDetailId },
        relations: { order: true },
      });
      if (!detail) throw new NotFoundException(`Line item ${item.orderDetailId} not found`);
      const order = detail.order;
      if (order.orgId !== orgId) {
        throw new BadRequestException(
          `Line item ${detail.name} does not belong to this organization`,
        );
      }
      if (order.userId !== userId) {
        throw new ForbiddenException(`You can only ship line items you placed (${detail.name})`);
      }
      if (detail.status !== OrderDetailStatus.RECEIVED) {
        throw new BadRequestException(
          `Line item ${detail.name} is not warehoused inventory and cannot be shipped`,
        );
      }
      const remaining = detail.qty - detail.shippedQty;
      if (item.qty > remaining) {
        throw new BadRequestException(
          `Line item ${detail.name} has only ${remaining} left to ship (requested ${item.qty})`,
        );
      }

      details.set(item.orderDetailId, detail);
    }
    return details;
  }

  /** Append a `shipment_history` row with a structured `changes` payload (see
   * {@link ShipmentChange}). One row per user action — the mirror of the order log. */
  private async writeHistory(
    em: EntityManager,
    shipmentId: string,
    actorId: string,
    changeType: ShipmentChangeType,
    changes: ShipmentChange | null,
    note: string | null,
  ): Promise<void> {
    await em.save(
      em.create(ShipmentHistory, { shipmentId, changedBy: actorId, changeType, changes, note }),
    );
  }

  /**
   * Build a `changes` line entry: the order line item's id + a name / order-number
   * snapshot (so a removed line still renders), plus any per-field diffs (`qty`).
   */
  private shipmentItemChange(
    detail: OrderDetail,
    fields?: Record<string, FieldDiff>,
  ): ShipmentItemChange {
    return {
      orderDetailId: detail.id,
      name: detail.name,
      ...(detail.order?.orderNumber ? { orderNumber: detail.order.orderNumber } : {}),
      ...(fields ? { fields } : {}),
    };
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
   * Populate each shipment's list-only `inventoryItemCount` / `totalQty` (how many orders it
   * draws from and their combined qty) in a single grouped query over the paginated
   * slice, so the list UI gets them without loading every line set.
   */
  private async attachItemSummary(shipments: Shipment[]): Promise<void> {
    if (shipments.length === 0) return;
    const ids = shipments.map((s) => s.id);
    const rows: Array<{ shipmentId: string; inventoryItemCount: string; totalQty: string }> =
      await this.shipmentRepo.manager
        .createQueryBuilder(ShipmentDetail, 'd')
        .select('d.shipmentId', 'shipmentId')
        .addSelect('COUNT(*)', 'inventoryItemCount')
        .addSelect('COALESCE(SUM(d.qty), 0)', 'totalQty')
        .where('d.shipmentId IN (:...ids)', { ids })
        .groupBy('d.shipmentId')
        .getRawMany();

    const summary = new Map(rows.map((r) => [r.shipmentId, r]));
    for (const s of shipments) {
      const row = summary.get(s.id);
      s.inventoryItemCount = row ? Number(row.inventoryItemCount) : 0;
      s.totalQty = row ? Number(row.totalQty) : 0;
    }

    // Flag which shipments have a label attached (one batched query), so the list UI
    // can show a "label ready to print" marker without loading the label rows.
    const labelled = await this.labelRepo
      .createQueryBuilder('l')
      .select('l.shipmentId', 'shipmentId')
      .where('l.shipmentId IN (:...ids)', { ids })
      .getRawMany<{ shipmentId: string }>();
    const withLabel = new Set(labelled.map((l) => l.shipmentId));
    for (const s of shipments) {
      s.hasLabel = withLabel.has(s.id);
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
      .leftJoin('item.orderDetail', 'd')
      .addSelect(['d.id', 'd.name', 'd.qty', 'd.shippedQty', 'd.status'])
      .leftJoin('d.order', 'o')
      .addSelect(['o.id', 'o.orderNumber', 'o.status'])
      .leftJoin('s.label', 'label')
      .addSelect('label.id')
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

    // Collapse the label relation to a flag; never expose the storage key.
    shipment.hasLabel = shipment.label != null;
    delete shipment.label;

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
   * Edit an unlocked (AWAITING) shipment's line items — `dto.items` **replaces** the
   * entire line set. Only the owning client may edit, and only before a reviewer locks
   * it. Records an ITEM_CHANGE history row. (The shipping label is managed through the
   * dedicated /label routes.)
   */
  async updateShipment(userId: string, shipmentId: string, dto: UpdateShipmentDto) {
    const shipment = await this.getShipment(userId, shipmentId);

    if (shipment.locked) {
      throw new ForbiddenException('Shipment is locked and can no longer be edited');
    }
    if (shipment.userId !== userId) {
      throw new ForbiddenException('Only the client who placed the shipment can edit it');
    }
    if (shipment.status !== ShipmentStatus.AWAITING) {
      throw new BadRequestException('Only an awaiting shipment can be edited');
    }

    await this.shipmentRepo.manager.transaction(async (em) => {
      const details = await this.validateItems(em, shipment.orgId, userId, dto.items);

      // Replace the line set: drop the old rows, insert the new ones.
      await em.delete(ShipmentDetail, { shipmentId: shipment.id });
      await em.save(
        dto.items.map((item) =>
          em.create(ShipmentDetail, {
            shipmentId: shipment.id,
            orderDetailId: item.orderDetailId,
            qty: item.qty,
          }),
        ),
      );

      // Diff the old line set against the new one and record a single ITEMS_CHANGED
      // summary row per edit; `changes.items` carries every line that changed — added
      // (to-only), qty-updated (from+to), or removed (from-only).
      const oldByDetail = new Map(shipment.items.map((i) => [i.orderDetailId, i]));
      const newByDetail = new Map(dto.items.map((i) => [i.orderDetailId, i]));
      const changedItems: ShipmentItemChange[] = [];

      for (const old of shipment.items) {
        if (!newByDetail.has(old.orderDetailId)) {
          changedItems.push(this.shipmentItemChange(old.orderDetail, { qty: { from: old.qty } }));
        }
      }
      for (const item of dto.items) {
        const old = oldByDetail.get(item.orderDetailId);
        const detail = details.get(item.orderDetailId)!;
        if (!old) {
          changedItems.push(this.shipmentItemChange(detail, { qty: { to: item.qty } }));
        } else if (old.qty !== item.qty) {
          changedItems.push(
            this.shipmentItemChange(detail, { qty: { from: old.qty, to: item.qty } }),
          );
        }
      }

      if (changedItems.length > 0) {
        const changes: ShipmentChange = { items: changedItems };
        await this.writeHistory(
          em,
          shipment.id,
          userId,
          ShipmentChangeType.ITEMS_CHANGED,
          changes,
          dto.note ?? null,
        );
      }
    });

    return this.getShipment(userId, shipment.id);
  }

  /**
   * A reviewer (`review_shipment`) reviews and locks an AWAITING shipment, handing
   * it to operations. Locking is the billing + fulfilment event, all in one
   * transaction:
   *   - the shipment's **client** (`shipment.userId`) is charged the org's flat
   *     `SHIPMENT_LOCK` fee (row locked FOR UPDATE; rejected if credit can't
   *     cover it; an org with no fee configured is charged nothing);
   *   - each line's qty is added to the order line item's `shipped_qty` (each
   *     `order_details` row locked FOR UPDATE and re-checked so concurrent locks can't
   *     over-ship); the order header is never touched;
   *   - a LOCKED history row is written.
   */
  async lockShipment(userId: string, shipmentId: string, dto: LockShipmentDto) {
    const shipment = await this.getShipment(userId, shipmentId);

    if (shipment.locked) {
      throw new BadRequestException('Shipment is already locked');
    }
    if (shipment.status !== ShipmentStatus.AWAITING) {
      throw new BadRequestException('Only an awaiting shipment can be reviewed and locked');
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

      // 2. Deduct each line's qty from the order line item it draws from. Each
      //    order_details row is locked FOR UPDATE and re-checked so two concurrent
      //    locks can't over-ship the same inventory. The order header is never touched.
      const items = await em.find(ShipmentDetail, { where: { shipmentId: shipment.id } });
      for (const item of items) {
        const detail = await em
          .createQueryBuilder(OrderDetail, 'd')
          .setLock('pessimistic_write')
          .where('d.id = :id', { id: item.orderDetailId })
          .getOne();
        if (!detail) throw new NotFoundException(`Line item ${item.orderDetailId} not found`);
        if (detail.status !== OrderDetailStatus.RECEIVED) {
          throw new BadRequestException(
            `Line item ${detail.name} is no longer warehoused inventory and cannot be shipped`,
          );
        }
        const newShipped = detail.shippedQty + item.qty;
        if (newShipped > detail.qty) {
          throw new BadRequestException(
            `Line item ${detail.name} would be over-shipped (only ${
              detail.qty - detail.shippedQty
            } left)`,
          );
        }

        detail.shippedQty = newShipped;
        await em.save(detail);
      }

      // 3. Lock the shipment and record it.
      shipment.locked = true;
      await em.save(shipment);

      const changes: ShipmentChange = { shipment: { locked: { from: false, to: true } } };
      await this.writeHistory(
        em,
        shipment.id,
        userId,
        ShipmentChangeType.LOCKED,
        changes,
        dto.note ?? null,
      );
    });

    return this.getShipment(userId, shipment.id);
  }

  /**
   * Move a shipment's status, recording a STATUS_CHANGED. Split by the lock gate:
   *   - while **unlocked**, only the owning client may act — cancelling an AWAITING
   *     shipment (nothing was deducted, so nothing is restored);
   *   - once **locked**, only operations (`process_shipment`) may act — marking it
   *     DONE, or CANCELLED (which returns the shipped qty to the order line items
   *     it drew from). The fee is not refunded.
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
        await this.restoreShippedQty(em, shipment);
      }

      const prevStatus = shipment.status;
      shipment.status = dto.status;
      await em.save(shipment);

      const changes: ShipmentChange = {
        shipment: { status: { from: prevStatus, to: dto.status } },
      };
      await this.writeHistory(
        em,
        shipment.id,
        userId,
        ShipmentChangeType.STATUS_CHANGED,
        changes,
        dto.note ?? null,
      );
    });

    return this.getShipment(userId, shipment.id);
  }

  /**
   * Reverse a locked shipment's stock deduction: subtract each line's qty back from
   * the order line item's `shipped_qty`, returning it to available inventory. Each
   * `order_details` row is locked FOR UPDATE.
   */
  private async restoreShippedQty(em: EntityManager, shipment: Shipment) {
    const items = await em.find(ShipmentDetail, { where: { shipmentId: shipment.id } });
    for (const item of items) {
      const detail = await em
        .createQueryBuilder(OrderDetail, 'd')
        .setLock('pessimistic_write')
        .where('d.id = :id', { id: item.orderDetailId })
        .getOne();
      if (!detail) continue;

      detail.shippedQty = Math.max(0, detail.shippedQty - item.qty);
      await em.save(detail);
    }
  }

  // --- Shipping label (printable image) -----------------------------------

  /**
   * Attach (or replace) the shipping-label image on a shipment. The owning **client**
   * provides the label the warehouse prints. One label per shipment: a re-upload
   * deletes the previous object first. Allowed only while the shipment is not terminal
   * (DONE/CANCELLED). Gated by `place_shipment` (see PERMISSION_API_MAP); `getShipment`
   * already restricts a client to their own shipments, and we re-assert ownership here.
   */
  async setLabel(userId: string, shipmentId: string, file: UploadedFile) {
    const shipment = await this.getShipment(userId, shipmentId);
    this.assertLabelEditable(shipment, userId);

    const existing = await this.labelRepo.findOne({ where: { shipmentId: shipment.id } });
    const previousKey = existing?.objectKey;
    const key = this.storage.buildKey('shipment-labels', file.filename, shipment.id);
    await this.storage.put(key, file.buffer, file.mimetype);

    const label = this.labelRepo.create({
      id: existing?.id,
      shipmentId: shipment.id,
      objectKey: key,
      contentType: file.mimetype,
      size: file.size,
    });
    const saved = await this.labelRepo.save(label);

    // Best-effort: drop the old object only after the new key is safely committed, so
    // a failed delete can never leave the row pointing at nothing.
    if (previousKey && previousKey !== key) await this.storage.delete(previousKey);

    return {
      shipmentId: shipment.id,
      contentType: saved.contentType,
      size: saved.size,
      uploadedAt: saved.createdAt,
    };
  }

  /**
   * Issue a **presigned URL** for a shipment's label so the browser (or the warehouse
   * print machine) loads it straight from the bucket — no bytes through the API. Valid
   * for `LABEL_URL_TTL_SECONDS`. Readable by anyone who can see the shipment (client /
   * reviewer / operations — the same scoping `getShipment` enforces). 404 if no label.
   * Pass `download` to force a save dialog instead of inline render.
   */
  async getLabelUrl(
    userId: string,
    shipmentId: string,
    download = false,
  ): Promise<{ url: string; expiresIn: number; contentType: string | null }> {
    await this.getShipment(userId, shipmentId);

    const label = await this.labelRepo.findOne({ where: { shipmentId } });
    if (!label) throw new NotFoundException('This shipment has no label attached');

    const filename = label.objectKey.split('/').pop() ?? 'label';
    const url = await this.storage.getSignedUrl(
      label.objectKey,
      LABEL_URL_TTL_SECONDS,
      download ? filename : undefined,
    );
    return { url, expiresIn: LABEL_URL_TTL_SECONDS, contentType: label.contentType };
  }

  /**
   * Remove a shipment's label (deletes the `shipment_labels` row and the stored
   * object). Same gating as {@link setLabel}: the owning client, while non-terminal.
   */
  async deleteLabel(userId: string, shipmentId: string) {
    const shipment = await this.getShipment(userId, shipmentId);
    this.assertLabelEditable(shipment, userId);

    const label = await this.labelRepo.findOne({ where: { shipmentId: shipment.id } });
    if (!label) throw new NotFoundException('This shipment has no label attached');

    await this.labelRepo.delete({ id: label.id });
    await this.storage.delete(label.objectKey);
    return { shipmentId: shipment.id, hasLabel: false };
  }

  /** Only the owning client may manage the label, and only before a terminal state. */
  private assertLabelEditable(shipment: Shipment, userId: string): void {
    if (shipment.userId !== userId) {
      throw new ForbiddenException('Only the client who placed the shipment can manage its label');
    }
    if (SHIPMENT_TERMINAL_STATUSES.includes(shipment.status)) {
      throw new BadRequestException(`Cannot change the label of a ${shipment.status} shipment`);
    }
  }

  /**
   * Delete labels belonging to DONE/CANCELLED shipments to reclaim storage: removes the
   * `shipment_labels` row and its bucket object (the shipment itself is untouched). A
   * label is only needed until the shipment is fulfilled or cancelled. Idempotent and
   * safe to run repeatedly — driven by a daily cron (see ShipmentLabelCleanupService).
   * Returns how many labels were removed.
   */
  async expireLabelsForClosedShipments(): Promise<number> {
    const stale = await this.labelRepo
      .createQueryBuilder('l')
      .innerJoin('l.shipment', 's')
      .where('s.status IN (:...statuses)', { statuses: [...SHIPMENT_TERMINAL_STATUSES] })
      .getMany();

    for (const label of stale) {
      await this.labelRepo.delete({ id: label.id });
      await this.storage.delete(label.objectKey);
    }
    return stale.length;
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
