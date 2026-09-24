import { IsEnum, IsNumber, Min } from 'class-validator';
import { FeeType } from '../../entities/org-fee.entity';

/**
 * Upsert a credit group's fee for an action (system-admin only). The amount must be
 * at least the org's flat fee for the same action, so the owner's markup is never
 * negative — enforced in the service against the current org fee.
 */
export class SetCreditGroupFeeDto {
  @IsEnum(FeeType)
  feeType: FeeType;

  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  amount: number;
}
