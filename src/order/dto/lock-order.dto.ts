import { IsOptional, IsString, MaxLength } from 'class-validator';

/** Body of POST /orders/:orderId/lock — a reviewer reviews and locks the order. */
export class LockOrderDto {
  /** Optional note recorded on the LOCKED history entry. */
  @IsOptional()
  @IsString()
  @MaxLength(1000)
  note?: string;
}
