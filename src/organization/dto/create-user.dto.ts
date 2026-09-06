import { IsEmail, IsOptional, IsUUID, MinLength } from 'class-validator';

export class CreateUserDto {
  @IsEmail()
  email: string;

  @MinLength(8)
  password: string;

  @IsOptional()
  displayName?: string;

  /** Organization the new user is added to. The acting user must belong to it
   *  (admins excepted), so a caller can't attach users to an org they're not in. */
  @IsUUID()
  orgId: string;

  /** Group (within `orgId`) the new user is placed into. */
  @IsUUID()
  groupId: string;
}
