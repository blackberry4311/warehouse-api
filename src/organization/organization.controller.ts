import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  UseGuards,
} from '@nestjs/common';
import { JwtAccessGuard } from '../auth/guards/jwt-access.guard';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { AuthenticatedUser } from '../auth/interfaces/jwt-payload.interface';
import { OrganizationService } from './organization.service';
import { CreateOrganizationDto } from './dto/create-organization.dto';
import { AddMemberDto } from './dto/add-member.dto';
import { CreateGroupDto } from './dto/create-group.dto';
import { AssignGroupDto } from './dto/assign-group.dto';
import { CreatePermissionDto } from './dto/create-permission.dto';
import { AssignPermissionDto } from './dto/assign-permission.dto';
import { CreateUserDto } from './dto/create-user.dto';
import { UpdateUserDto } from './dto/update-user.dto';

// Access control is enforced globally by PermissionsGuard via API_PERMISSION_MAP
// (see src/auth/permissions.config.ts) — no per-route guards/decorators here.
@Controller('organizations')
export class OrganizationController {
  constructor(private readonly orgService: OrganizationService) {}

  // --- User provisioning ---------------------------------------------------

  @Post('users')
  createUser(@CurrentUser() actor: AuthenticatedUser, @Body() dto: CreateUserDto) {
    return this.orgService.createUser(actor.userId, dto);
  }

  // Edit everything on a user except their email (see UpdateUserDto).
  @Patch('users/:userId')
  updateUser(
    @CurrentUser() actor: AuthenticatedUser,
    @Param('userId', ParseUUIDPipe) userId: string,
    @Body() dto: UpdateUserDto,
  ) {
    return this.orgService.updateUser(actor.userId, userId, dto);
  }

  @Get('me')
  @UseGuards(JwtAccessGuard)
  getMyAccess(@CurrentUser() user: AuthenticatedUser) {
    return this.orgService.getUserAccess(user.userId);
  }

  // --- Organizations -------------------------------------------------------

  @Post()
  createOrganization(@Body() dto: CreateOrganizationDto) {
    return this.orgService.createOrganization(dto);
  }

  @Get()
  listOrganizations() {
    return this.orgService.listOrganizations();
  }

  @Get(':orgId')
  getOrganization(@Param('orgId', ParseUUIDPipe) orgId: string) {
    return this.orgService.getOrganization(orgId);
  }

  @Delete(':orgId')
  deleteOrganization(@Param('orgId', ParseUUIDPipe) orgId: string) {
    return this.orgService.deleteOrganization(orgId);
  }

  // --- Membership ----------------------------------------------------------

  @Post(':orgId/members')
  addMember(@Param('orgId', ParseUUIDPipe) orgId: string, @Body() dto: AddMemberDto) {
    return this.orgService.addMember(orgId, dto.userId);
  }

  @Get(':orgId/members')
  listMembers(@Param('orgId', ParseUUIDPipe) orgId: string) {
    return this.orgService.listMembers(orgId);
  }

  @Delete(':orgId/members/:userId')
  removeMember(
    @Param('orgId', ParseUUIDPipe) orgId: string,
    @Param('userId', ParseUUIDPipe) userId: string,
  ) {
    return this.orgService.removeMember(orgId, userId);
  }

  @Get(':orgId/members/:userId/permissions')
  getUserPermissions(
    @Param('orgId', ParseUUIDPipe) orgId: string,
    @Param('userId', ParseUUIDPipe) userId: string,
  ) {
    return this.orgService.getUserPermissions(orgId, userId);
  }

  @Get(':orgId/members/:userId/groups')
  listUserGroups(
    @Param('orgId', ParseUUIDPipe) orgId: string,
    @Param('userId', ParseUUIDPipe) userId: string,
  ) {
    return this.orgService.listUserGroups(orgId, userId);
  }

  // --- Groups (roles) ------------------------------------------------------

  @Post(':orgId/groups')
  createGroup(@Param('orgId', ParseUUIDPipe) orgId: string, @Body() dto: CreateGroupDto) {
    return this.orgService.createGroup(orgId, dto);
  }

  @Get(':orgId/groups')
  listGroups(@Param('orgId', ParseUUIDPipe) orgId: string) {
    return this.orgService.listGroups(orgId);
  }

  @Delete(':orgId/groups/:groupId')
  deleteGroup(
    @Param('orgId', ParseUUIDPipe) orgId: string,
    @Param('groupId', ParseUUIDPipe) groupId: string,
  ) {
    return this.orgService.deleteGroup(orgId, groupId);
  }

  // --- User <-> group assignment ------------------------------------------

  @Post(':orgId/groups/:groupId/members')
  assignUserToGroup(
    @Param('orgId', ParseUUIDPipe) orgId: string,
    @Param('groupId', ParseUUIDPipe) groupId: string,
    @Body() dto: AssignGroupDto,
  ) {
    return this.orgService.assignUserToGroup(orgId, groupId, dto.userId);
  }

  @Delete(':orgId/groups/:groupId/members/:userId')
  removeUserFromGroup(
    @Param('orgId', ParseUUIDPipe) orgId: string,
    @Param('groupId', ParseUUIDPipe) groupId: string,
    @Param('userId', ParseUUIDPipe) userId: string,
  ) {
    return this.orgService.removeUserFromGroup(orgId, groupId, userId);
  }

  // --- Group <-> permission grants ----------------------------------------

  @Get(':orgId/groups/:groupId/permissions')
  listGroupPermissions(
    @Param('orgId', ParseUUIDPipe) orgId: string,
    @Param('groupId', ParseUUIDPipe) groupId: string,
  ) {
    return this.orgService.listGroupPermissions(orgId, groupId);
  }

  @Post(':orgId/groups/:groupId/permissions')
  grantPermissionToGroup(
    @Param('orgId', ParseUUIDPipe) orgId: string,
    @Param('groupId', ParseUUIDPipe) groupId: string,
    @Body() dto: AssignPermissionDto,
  ) {
    return this.orgService.grantPermissionToGroup(orgId, groupId, dto.permissionId);
  }

  @Delete(':orgId/groups/:groupId/permissions/:permissionId')
  revokePermissionFromGroup(
    @Param('orgId', ParseUUIDPipe) orgId: string,
    @Param('groupId', ParseUUIDPipe) groupId: string,
    @Param('permissionId', ParseUUIDPipe) permissionId: string,
  ) {
    return this.orgService.revokePermissionFromGroup(orgId, groupId, permissionId);
  }

  // --- Permissions (global catalog) ---------------------------------------

  @Post('permissions/catalog')
  createPermission(@Body() dto: CreatePermissionDto) {
    return this.orgService.createPermission(dto);
  }

  @Get('permissions/catalog')
  listPermissions() {
    return this.orgService.listPermissions();
  }
}
