import { IsNotEmpty, IsNumber, IsOptional, IsPositive, IsString, MaxLength } from 'class-validator';

/**
 * Body of PATCH /orders/:orderId/details/:detailId — edit a line's `name` (free
 * text; the client code is re-prepended), `qty`, and/or `note`. All optional; at
 * least one must be present (enforced in the service). Receipt status is changed via
 * the separate /status route.
 */
export class UpdateOrderDetailDto {
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  @MaxLength(200)
  name?: string;

  @IsOptional()
  @IsNumber()
  @IsPositive()
  qty?: number;

  @IsOptional()
  @IsString()
  @MaxLength(1000)
  note?: string;
}
