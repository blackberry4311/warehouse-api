import { IsNumber, IsOptional, IsPositive, IsString, MaxLength } from 'class-validator';

/** Add funds to a member's credit (records a TOP_UP ledger entry). */
export class TopUpCreditDto {
  /** Amount to add. Must be positive — use it only to top a member up. */
  @IsNumber({ maxDecimalPlaces: 2 })
  @IsPositive()
  amount: number;

  /** Optional free-text note recorded on the ledger entry. */
  @IsOptional()
  @IsString()
  @MaxLength(1000)
  note?: string;
}
