import { IsUUID } from 'class-validator';

/** Update a credit group's owner (system-admin only). */
export class UpdateCreditGroupDto {
  /** The new owner (reviewer/reseller who earns the markup). Must belong to the org. */
  @IsUUID()
  ownerUserId: string;
}
