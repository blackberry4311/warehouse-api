import { IsIn, IsOptional, IsString, MaxLength } from 'class-validator';
import { OrderDetailStatus } from '../../entities/order-detail.entity';

/** Receipt outcomes operations may set on a line (PENDING is the initial state, not
 * something you move *to*). */
const RECEIPT_STATUSES = [
  OrderDetailStatus.RECEIVED,
  OrderDetailStatus.NOT_ARRIVED,
  OrderDetailStatus.CANCELLED,
] as const;

/**
 * Body of PATCH /orders/:orderId/details/:detailId/status — operations confirms a
 * line as RECEIVED (now inventory), NOT_ARRIVED, or CANCELLED once the order is
 * locked.
 */
export class UpdateOrderDetailStatusDto {
  @IsIn(RECEIPT_STATUSES)
  status: OrderDetailStatus;

  @IsOptional()
  @IsString()
  @MaxLength(1000)
  note?: string;
}
