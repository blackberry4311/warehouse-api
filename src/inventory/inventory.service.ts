import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { OrderDetail, OrderDetailStatus } from '../entities/order-detail.entity';
import { OrganizationService } from '../organization/organization.service';
import { decodeCursor, Page, parseLimit, toPage } from '../common/pagination.util';

/**
 * One inventory row the FE renders: a RECEIVED order line item with stock still
 * available to ship (`remaining = qty - shippedQty > 0`), carrying enough of its
 * owning order for the client to recognise it and place a shipment straight from it.
 * `detailId` is what a shipment line references (`ShipmentItemDto.orderDetailId`).
 */
export interface InventoryItem {
  detailId: string;
  orderId: string;
  orderNumber: string;
  /** The client who owns the stock (the order's placer). */
  clientId: string;
  name: string;
  qty: number;
  remaining: number;
  note: string | null;
  createdAt: Date;
}

/**
 * Read-only view over warehoused inventory: the RECEIVED order line items that still
 * have stock left to ship. It is the basis for placing a shipment — a client browses
 * their inventory here, then references a line's `detailId` in a shipment.
 */
@Injectable()
export class InventoryService {
  constructor(
    @InjectRepository(OrderDetail) private detailRepo: Repository<OrderDetail>,
    private readonly orgService: OrganizationService,
  ) {}

  /**
   * List an org's available inventory, newest line first, keyset-paginated by
   * (created_at, id). Gated (in `PERMISSION_API_MAP`) by any of the shipment
   * permissions; scoping mirrors shipments — a reviewer (`review_shipment`) or
   * operations (`process_shipment`), and admins, see every client's inventory in the
   * org, while a plain client (`place_shipment`) sees only their own. Optional
   * `search` matches the order number or the line name (case-insensitive).
   */
  async listInventory(
    userId: string,
    orgId: string,
    limitRaw?: string,
    cursor?: string,
    search?: string,
  ): Promise<Page<InventoryItem>> {
    await this.orgService.getOrganization(orgId);
    await this.orgService.assertOrgMembership(orgId, userId);

    // Reviewers / operations (and admins) see all org inventory; otherwise a client
    // sees only the lines on the orders they placed.
    const [canReview, canManage] = await Promise.all([
      this.orgService.hasOrgPermission(orgId, userId, 'review_shipment'),
      this.orgService.hasOrgPermission(orgId, userId, 'process_shipment'),
    ]);
    const seesAll = canReview || canManage;

    const limit = parseLimit(limitRaw);
    const qb = this.detailRepo
      .createQueryBuilder('d')
      .innerJoinAndSelect('d.order', 'o')
      .where('o.orgId = :orgId', { orgId })
      .andWhere('d.status = :received', { received: OrderDetailStatus.RECEIVED })
      .andWhere('d.qty > d.shippedQty')
      .orderBy('d.createdAt', 'DESC')
      .addOrderBy('d.id', 'DESC')
      .take(limit + 1);

    if (!seesAll) {
      qb.andWhere('o.userId = :userId', { userId });
    }

    const term = search?.trim();
    if (term) {
      qb.andWhere('(o.orderNumber ILIKE :term OR d.name ILIKE :term)', { term: `%${term}%` });
    }

    if (cursor) {
      const { t, id } = decodeCursor(cursor);
      qb.andWhere('(d.createdAt < :t OR (d.createdAt = :t AND d.id < :id))', {
        t: new Date(t),
        id,
      });
    }

    const page = toPage(await qb.getMany(), limit);
    return {
      items: page.items.map((d) => this.toItem(d)),
      nextCursor: page.nextCursor,
    };
  }

  /** Shape a loaded line (with its `order` relation) into an {@link InventoryItem}. */
  private toItem(d: OrderDetail): InventoryItem {
    return {
      detailId: d.id,
      orderId: d.orderId,
      orderNumber: d.order.orderNumber,
      clientId: d.order.userId,
      name: d.name,
      qty: d.qty,
      remaining: d.qty - d.shippedQty,
      note: d.note,
      createdAt: d.createdAt,
    };
  }
}
