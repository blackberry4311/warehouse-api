import { Type } from 'class-transformer';
import {
  ArrayMinSize,
  IsArray,
  IsOptional,
  IsString,
  MaxLength,
  ValidateNested,
} from 'class-validator';
import { ShipmentItemDto } from './shipment-item.dto';

/**
 * Body of PATCH /shipments/:shipmentId — edit a still-unlocked (AWAITING) shipment's
 * line items. `items` **replaces** the shipment's entire line set (required — the
 * shipment label is managed via the dedicated /label routes, not here).
 */
export class UpdateShipmentDto {
  @IsArray()
  @ArrayMinSize(1)
  @ValidateNested({ each: true })
  @Type(() => ShipmentItemDto)
  items: ShipmentItemDto[];

  /** Optional note recorded on the resulting item-change history entries. */
  @IsOptional()
  @IsString()
  @MaxLength(1000)
  note?: string;
}
