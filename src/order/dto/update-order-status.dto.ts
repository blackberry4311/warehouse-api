import { IsIn, IsOptional, IsString, MaxLength } from 'class-validator';
import { OrderStatus } from '../../entities/order.entity';

/** The order-header states a caller may move an order to. */
const MANAGED_STATUSES = [
  OrderStatus.IN_TRANSIT,
  OrderStatus.IN_WAREHOUSE,
  OrderStatus.CANCELLED,
] as const;

export class UpdateOrderStatusDto {
  @IsIn(MANAGED_STATUSES)
  status: OrderStatus;

  /** Optional note recorded on the STATUS_CHANGE history entry. */
  @IsOptional()
  @IsString()
  @MaxLength(1000)
  note?: string;
}
