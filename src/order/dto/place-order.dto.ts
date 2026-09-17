import { Type } from 'class-transformer';
import {
  ArrayNotEmpty,
  IsArray,
  IsNotEmpty,
  IsNumber,
  IsOptional,
  IsPositive,
  IsString,
  IsUUID,
  MaxLength,
  ValidateNested,
} from 'class-validator';

/** One line the client declares when placing an order. */
export class OrderDetailInput {
  /**
   * Free text naming this line (e.g. "blue widgets"). The server slugifies it and
   * prepends the client's code with a hyphen to form the stored line name
   * (`ACME-blue-widgets`) — the client does not send the code.
   */
  @IsString()
  @IsNotEmpty()
  @MaxLength(200)
  name: string;

  @IsNumber()
  @IsPositive()
  qty: number;

  /** Optional per-line note. */
  @IsOptional()
  @IsString()
  @MaxLength(1000)
  note?: string;
}

export class PlaceOrderDto {
  /** Organization the order is placed into. The caller must belong to it. */
  @IsUUID()
  orgId: string;

  /** The order's line items — at least one. Quantity lives here, not on the order. */
  @IsArray()
  @ArrayNotEmpty()
  @ValidateNested({ each: true })
  @Type(() => OrderDetailInput)
  details: OrderDetailInput[];

  /**
   * Free-text tracking reference (typically a carrier URL) for the shipment.
   * Required: the goods always move through an external shipper, so the client
   * always has one to supply at placement.
   */
  @IsString()
  @IsNotEmpty()
  @MaxLength(2048)
  tracking: string;

  /** Optional free-text note recorded on the CREATED history entry. */
  @IsOptional()
  @IsString()
  @MaxLength(1000)
  note?: string;
}
