import { IsEnum, IsNumber, Min } from 'class-validator';
import { FeeType } from '../../entities/org-fee.entity';

/** Upsert an organization's per-unit fee for an action (system-admin only); charged × qty on lock. */
export class SetOrgFeeDto {
  @IsEnum(FeeType)
  feeType: FeeType;

  /** Amount charged per action. 0 effectively disables charging for this fee. */
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  amount: number;
}
