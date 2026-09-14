import { Type } from 'class-transformer';
import {
  ArrayMinSize,
  IsArray,
  IsNotEmpty,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
  ValidateNested,
} from 'class-validator';
import { ShipmentItemDto } from './shipment-item.dto';

export class PlaceShipmentDto {
  /** Organization the shipment is placed into. The caller must belong to it. */
  @IsUUID()
  orgId: string;

  /**
   * The orders and per-order quantities to ship. At least one line; each order may
   * appear at most once (enforced in the service). Every referenced order must be
   * one the caller placed, in `orgId`, and IN_WAREHOUSE with enough remaining qty.
   */
  @IsArray()
  @ArrayMinSize(1)
  @ValidateNested({ each: true })
  @Type(() => ShipmentItemDto)
  items: ShipmentItemDto[];

  /** Optional outbound tracking reference (typically a carrier URL). */
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  @MaxLength(2048)
  tracking?: string;

  /** Optional free-text note recorded on the CREATED history entry. */
  @IsOptional()
  @IsString()
  @MaxLength(1000)
  note?: string;
}
