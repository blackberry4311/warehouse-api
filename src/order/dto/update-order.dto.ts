import { IsNotEmpty, IsNumber, IsOptional, IsPositive, IsString, MaxLength } from 'class-validator';

/**
 * Body of PATCH /orders/:orderId — edit a still-editable order's `qty` and/or its
 * `tracking` reference. Both are optional; supply either or both. At least one must
 * be present (enforced in the service).
 */
export class UpdateOrderDto {
  @IsOptional()
  @IsNumber()
  @IsPositive()
  qty?: number;

  @IsOptional()
  @IsString()
  @IsNotEmpty()
  @MaxLength(2048)
  tracking?: string;

  /** Optional note recorded on the QTY_CHANGE history entry. */
  @IsOptional()
  @IsString()
  @MaxLength(1000)
  note?: string;
}
