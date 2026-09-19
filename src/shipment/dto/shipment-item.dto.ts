import { IsNumber, IsPositive, IsUUID } from 'class-validator';

/**
 * One line of a shipment: ship `qty` out of the order line item (inventory unit)
 * identified by `orderDetailId`. A shipment carries one or more of these (the
 * many-to-many with order line items).
 */
export class ShipmentItemDto {
  /**
   * An order line item the caller placed, RECEIVED (warehoused inventory), in the
   * shipment's org, with enough remaining qty (`qty - shipped_qty`) to cover `qty`.
   */
  @IsUUID()
  orderDetailId: string;

  /** Quantity to ship from that line; must not exceed the line's remaining qty. */
  @IsNumber()
  @IsPositive()
  qty: number;
}
