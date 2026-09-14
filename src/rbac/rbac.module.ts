import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { JwtModule } from '@nestjs/jwt';
import { TypeOrmModule } from '@nestjs/typeorm';
import { User } from '../entities/user.entity';
import { OrganizationModule } from '../organization/organization.module';
import { PermissionsGuard } from './guards/permissions.guard';

/**
 * Owns request authorization: the map-driven global `PermissionsGuard`
 * (registered via `APP_GUARD`, so it runs on every route) and the authored
 * `PERMISSION_API_MAP` source of truth. Built on top of the RBAC data layer —
 * it imports `OrganizationModule` for `OrganizationService`
 * (permission resolution). Nothing imports this module back, so the dependency
 * graph stays acyclic: Rbac -> Organization -> Auth.
 */
@Module({
  imports: [
    JwtModule.register({}),
    TypeOrmModule.forFeature([User]),
    OrganizationModule,
  ],
  providers: [{ provide: APP_GUARD, useClass: PermissionsGuard }],
})
export class RbacModule {}
