import { IsEnum, IsOptional, IsString, MaxLength } from 'class-validator';
import { ShipmentStatus } from '../../entities/shipment.entity';

export class UpdateShipmentStatusDto {
  @IsEnum(ShipmentStatus)
  status: ShipmentStatus;

  /** Optional note recorded on the STATUS_CHANGE history entry. */
  @IsOptional()
  @IsString()
  @MaxLength(1000)
  note?: string;
}
