import { IsEnum, IsString, MaxLength, MinLength } from 'class-validator';
import { PermissionCategory } from '../../entities/permission.entity';

export class CreatePermissionDto {
  @IsString()
  @MinLength(1)
  @MaxLength(255)
  name: string;

  @IsString()
  @MinLength(1)
  description: string;

  @IsEnum(PermissionCategory)
  category: PermissionCategory;
}
