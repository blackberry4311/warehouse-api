import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { JwtModule } from '@nestjs/jwt';
import { TypeOrmModule } from '@nestjs/typeorm';
import { OrganizationController } from './organization.controller';
import { OrganizationService } from './organization.service';
import { PermissionsGuard } from './guards/permissions.guard';
import { Organization } from '../entities/organization.entity';
import { UserOrg } from '../entities/user-org.entity';
import { OrgGroup } from '../entities/org-group.entity';
import { Permission } from '../entities/permission.entity';
import { UserGroup } from '../entities/user-group.entity';
import { GroupPermission } from '../entities/group-permission.entity';
import { User } from '../entities/user.entity';

@Module({
  imports: [
    JwtModule.register({}),
    TypeOrmModule.forFeature([
      Organization,
      UserOrg,
      OrgGroup,
      Permission,
      UserGroup,
      GroupPermission,
      User,
    ]),
  ],
  controllers: [OrganizationController],
  providers: [OrganizationService, { provide: APP_GUARD, useClass: PermissionsGuard }],
  exports: [OrganizationService],
})
export class OrganizationModule {}
