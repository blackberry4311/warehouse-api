import { IsNotEmpty, IsNumber, IsString, MaxLength, NotEquals } from 'class-validator';

/** Manually correct a member's credit (records an ADJUSTMENT ledger entry). */
export class AdjustCreditDto {
  /** Signed amount: positive adds to the balance, negative deducts (e.g. a refund reversal). */
  @IsNumber({ maxDecimalPlaces: 2 })
  @NotEquals(0)
  amount: number;

  /** Why the balance was corrected — required, shown to the member on the ledger. */
  @IsString()
  @IsNotEmpty()
  @MaxLength(1000)
  note: string;
}
