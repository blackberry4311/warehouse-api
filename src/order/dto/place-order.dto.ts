import { IsNumber, IsOptional, IsPositive, IsString, IsUUID, MaxLength } from 'class-validator';

export class PlaceOrderDto {
  /** Organization the order is placed into. The caller must belong to it. */
  @IsUUID()
  orgId: string;

  @IsNumber()
  @IsPositive()
  qty: number;

  /** Optional free-text note recorded on the CREATED history entry. */
  @IsOptional()
  @IsString()
  @MaxLength(1000)
  note?: string;
}
