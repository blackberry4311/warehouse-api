import {
  IsEmail,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  MaxLength,
  MinLength,
} from 'class-validator';

export class CreateUserDto {
  @IsEmail()
  email: string;

  @MinLength(8)
  password: string;

  @IsOptional()
  displayName?: string;

  /** Client code for order numbers. If omitted, derived from displayName/email.
   *  Uppercase letters/digits only; must be unique across users. */
  @IsOptional()
  @IsString()
  @MaxLength(16)
  @Matches(/^[A-Z0-9]+$/, { message: 'code must be uppercase letters and digits only' })
  code?: string;

  /** Organization the new user is added to. The acting user must belong to it
   *  (admins excepted), so a caller can't attach users to an org they're not in. */
  @IsUUID()
  orgId: string;

  /** Group (within `orgId`) the new user is placed into. */
  @IsUUID()
  groupId: string;
}
