import { IsOptional, MinLength } from 'class-validator';

/**
 * Update an existing user. Everything on the user is editable EXCEPT `email`:
 * it is deliberately absent here, and with the global ValidationPipe's
 * `forbidNonWhitelisted: true` a request that sends `email` is rejected (400),
 * so the address can never be changed through this endpoint.
 */
export class UpdateUserDto {
  @IsOptional()
  displayName?: string;

  @IsOptional()
  @MinLength(8)
  password?: string;
}
