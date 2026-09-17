import { IsNotEmpty, IsNumber, IsOptional, IsPositive, IsString, MaxLength } from 'class-validator';

/**
 * Body of POST /orders/:orderId/details — add one line to an existing order. As at
 * placement, `name` is the client's free text; the server prepends the order's
 * client code.
 */
export class AddOrderDetailDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(200)
  name: string;

  @IsNumber()
  @IsPositive()
  qty: number;

  @IsOptional()
  @IsString()
  @MaxLength(1000)
  note?: string;
}
