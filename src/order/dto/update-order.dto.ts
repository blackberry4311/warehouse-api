import { IsNumber, IsOptional, IsPositive, IsString, MaxLength } from 'class-validator';

/** Body of PATCH /orders/:orderId — the order owner edits a still-pending order. */
export class UpdateOrderDto {
  @IsNumber()
  @IsPositive()
  qty: number;

  /** Optional note recorded on the QTY_CHANGE history entry. */
  @IsOptional()
  @IsString()
  @MaxLength(1000)
  note?: string;
}
