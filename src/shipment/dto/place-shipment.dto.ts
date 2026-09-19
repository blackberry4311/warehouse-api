import { Type } from 'class-transformer';
import {
  ArrayMinSize,
  IsArray,
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
   * The order line items and per-line quantities to ship. At least one line; each
   * line may appear at most once (enforced in the service). Every referenced line
   * must be one the caller placed, in `orgId`, and RECEIVED with enough remaining qty.
   */
  @IsArray()
  @ArrayMinSize(1)
  @ValidateNested({ each: true })
  @Type(() => ShipmentItemDto)
  items: ShipmentItemDto[];

  /** Optional free-text note recorded on the CREATED history entry. */
  @IsOptional()
  @IsString()
  @MaxLength(1000)
  note?: string;
}
