import { IsUUID } from 'class-validator';

/** Add a client to a credit group (system-admin only). */
export class AddCreditGroupMemberDto {
  @IsUUID()
  userId: string;
}
