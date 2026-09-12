import {
  IsIn,
  IsNotEmpty,
  IsNumber,
  IsOptional,
  IsPositive,
  IsString,
  IsUUID,
  MaxLength,
} from 'class-validator';
import { OrderStatus } from '../../entities/order.entity';

/** The two pending states a client may place an order in (reporting its progress). */
const PLACEABLE_STATUSES = [OrderStatus.SHIPPING, OrderStatus.ARRIVING] as const;

export class PlaceOrderDto {
  /** Organization the order is placed into. The caller must belong to it. */
  @IsUUID()
  orgId: string;

  @IsNumber()
  @IsPositive()
  qty: number;

  /**
   * Free-text tracking reference (typically a carrier URL) for the shipment.
   * Required: the goods always move through an external shipper, so the client
   * always has one to supply at placement.
   */
  @IsString()
  @IsNotEmpty()
  @MaxLength(2048)
  tracking: string;

  /**
   * Initial status the client reports for the goods. Only the two pending states
   * (SHIPPING/ARRIVING) are accepted; defaults to SHIPPING when omitted.
   */
  @IsOptional()
  @IsIn(PLACEABLE_STATUSES)
  status?: OrderStatus;

  /** Optional free-text note recorded on the CREATED history entry. */
  @IsOptional()
  @IsString()
  @MaxLength(1000)
  note?: string;
}
