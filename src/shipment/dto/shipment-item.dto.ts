import { IsNumber, IsPositive, IsUUID } from 'class-validator';

/**
 * One line of a shipment: ship `qty` out of the order identified by `orderId`.
 * A shipment carries one or more of these (the many-to-many with orders).
 */
export class ShipmentItemDto {
  /** An order the caller placed, currently IN_WAREHOUSE, in the shipment's org. */
  @IsUUID()
  orderId: string;

  /** Quantity to ship from that order; must not exceed the order's remaining qty. */
  @IsNumber()
  @IsPositive()
  qty: number;
}
