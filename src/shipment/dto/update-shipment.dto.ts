import { Type } from 'class-transformer';
import {
  ArrayMinSize,
  IsArray,
  IsNotEmpty,
  IsOptional,
  IsString,
  MaxLength,
  ValidateNested,
} from 'class-validator';
import { ShipmentItemDto } from './shipment-item.dto';

/**
 * Body of PATCH /shipments/:shipmentId — edit a still-unlocked (REQUESTED)
 * shipment's line items and/or its tracking reference. Both optional; at least one
 * must be present (enforced in the service). When `items` is supplied it **replaces**
 * the shipment's entire line set.
 */
export class UpdateShipmentDto {
  @IsOptional()
  @IsArray()
  @ArrayMinSize(1)
  @ValidateNested({ each: true })
  @Type(() => ShipmentItemDto)
  items?: ShipmentItemDto[];

  @IsOptional()
  @IsString()
  @IsNotEmpty()
  @MaxLength(2048)
  tracking?: string;

  /** Optional note recorded on the ITEM_CHANGE history entry. */
  @IsOptional()
  @IsString()
  @MaxLength(1000)
  note?: string;
}
