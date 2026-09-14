import { IsOptional, IsString, MaxLength } from 'class-validator';

/** Body of POST /shipments/:shipmentId/lock — a reviewer reviews and locks it. */
export class LockShipmentDto {
  /** Optional note recorded on the LOCKED history entry. */
  @IsOptional()
  @IsString()
  @MaxLength(1000)
  note?: string;
}
