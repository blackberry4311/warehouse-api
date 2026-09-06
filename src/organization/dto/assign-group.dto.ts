import { IsUUID } from 'class-validator';

export class AssignGroupDto {
  @IsUUID()
  userId: string;
}
