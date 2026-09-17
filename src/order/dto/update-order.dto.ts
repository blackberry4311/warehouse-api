import { IsNotEmpty, IsString, MaxLength } from 'class-validator';

/**
 * Body of PATCH /orders/:orderId — edit the order **header**. Quantity moved onto
 * the lines, so the only header-level field a client/reviewer edits here is the
 * `tracking` reference; line changes go through the /details routes.
 */
export class UpdateOrderDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(2048)
  tracking: string;
}
