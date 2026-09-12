import { IsString, MaxLength, MinLength } from 'class-validator';

/** Body of PATCH /organizations/:orgId — rename an organization. */
export class UpdateOrganizationDto {
  @IsString()
  @MinLength(1)
  @MaxLength(255)
  name: string;
}
