import { IsOptional, MinLength } from 'class-validator';

/**
 * Self-service profile update for the current user. Mirrors `UpdateUserDto`:
 * everything the user manages about themselves is editable EXCEPT `email` (and
 * `code`, which feeds order numbers). `email` is deliberately absent, and with the
 * global ValidationPipe's `forbidNonWhitelisted: true` a request that sends it is
 * rejected (400), so the address can never be changed through this endpoint.
 */
export class UpdateProfileDto {
  @IsOptional()
  displayName?: string;

  @IsOptional()
  @MinLength(8)
  password?: string;
}
