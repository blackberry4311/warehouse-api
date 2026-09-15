import { IsNotEmpty, IsNumber, IsOptional, IsPositive, IsString, MaxLength } from 'class-validator';

/**
 * Body of `POST /orders/:orderId/fees` and `POST /shipments/:shipmentId/fees` —
 * a staffer adds a named ad-hoc fee that is charged to the client immediately.
 */
export class CreateExtraFeeDto {
  /** Human-readable fee name shown to the client. */
  @IsString()
  @IsNotEmpty()
  @MaxLength(200)
  name: string;

  /** Amount to charge; must be positive. */
  @IsNumber()
  @IsPositive()
  amount: number;

  /** Optional note recorded on the fee and its ledger entry. */
  @IsOptional()
  @IsString()
  @MaxLength(1000)
  note?: string;
}
