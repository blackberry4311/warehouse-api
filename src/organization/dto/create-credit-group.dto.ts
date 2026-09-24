import { IsString, IsNotEmpty, IsUUID, MaxLength } from 'class-validator';

/** Create a credit group in an org (system-admin only). */
export class CreateCreditGroupDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(255)
  name: string;

  /** The reviewer/reseller who owns the group and earns its markup. Must belong to the org. */
  @IsUUID()
  ownerUserId: string;
}
