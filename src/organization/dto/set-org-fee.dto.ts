import { IsEnum, IsNumber, Min } from 'class-validator';
import { FeeType } from '../../entities/org-fee.entity';

/** Upsert an organization's flat fee for an action (system-admin only). */
export class SetOrgFeeDto {
  @IsEnum(FeeType)
  feeType: FeeType;

  /** Amount charged per action. 0 effectively disables charging for this fee. */
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  amount: number;
}
