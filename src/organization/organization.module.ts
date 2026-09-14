import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { OrganizationController } from './organization.controller';
import { OrganizationService } from './organization.service';
import { Organization } from '../entities/organization.entity';
import { UserOrg } from '../entities/user-org.entity';
import { OrgGroup } from '../entities/org-group.entity';
import { Permission } from '../entities/permission.entity';
import { UserGroup } from '../entities/user-group.entity';
import { GroupPermission } from '../entities/group-permission.entity';
import { User } from '../entities/user.entity';
import { OrgFee } from '../entities/org-fee.entity';
import { CreditHistory } from '../entities/credit-history.entity';

@Module({
  imports: [
    TypeOrmModule.forFeature([
      Organization,
      UserOrg,
      OrgGroup,
      Permission,
      UserGroup,
      GroupPermission,
      User,
      OrgFee,
      CreditHistory,
    ]),
  ],
  controllers: [OrganizationController],
  providers: [OrganizationService],
  exports: [OrganizationService],
})
export class OrganizationModule {}
