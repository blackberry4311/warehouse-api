import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Put,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import { JwtAccessGuard } from '../auth/guards/jwt-access.guard';
import { MAX_UPLOAD_BYTES, readSingleUploadedFile } from '../common/uploaded-file.util';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { AuthenticatedUser } from '../auth/interfaces/jwt-payload.interface';
import { OrganizationService } from './organization.service';
import { CreateOrganizationDto } from './dto/create-organization.dto';
import { UpdateOrganizationDto } from './dto/update-organization.dto';
import { AddMemberDto } from './dto/add-member.dto';
import { CreateGroupDto } from './dto/create-group.dto';
import { AssignGroupDto } from './dto/assign-group.dto';
import { CreatePermissionDto } from './dto/create-permission.dto';
import { AssignPermissionDto } from './dto/assign-permission.dto';
import { CreateUserDto } from './dto/create-user.dto';
import { UpdateUserDto } from './dto/update-user.dto';
import { SetOrgFeeDto } from './dto/set-org-fee.dto';
import { TopUpCreditDto } from './dto/top-up-credit.dto';

/** Image/PDF types accepted for a top-up bill (receipt). */
const BILL_ALLOWED_MIME_TYPES = ['image/jpeg', 'image/png', 'image/webp', 'application/pdf'];

// Access control is enforced globally by PermissionsGuard via API_PERMISSION_MAP
// (see src/rbac/permissions.config.ts) — no per-route guards/decorators here.
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

  @Patch(':orgId')
  updateOrganization(
    @Param('orgId', ParseUUIDPipe) orgId: string,
    @Body() dto: UpdateOrganizationDto,
  ) {
    return this.orgService.updateOrganization(orgId, dto);
  }

  @Delete(':orgId')
  deleteOrganization(@Param('orgId', ParseUUIDPipe) orgId: string) {
    return this.orgService.deleteOrganization(orgId);
  }

  // --- Org fees (system-admin only) ----------------------------------------
  // Not in PERMISSION_API_MAP: JwtAccessGuard enforces auth, the service enforces
  // is_admin. Billing config is a system-admin concern, not an org permission.

  @Post(':orgId/fees')
  @UseGuards(JwtAccessGuard)
  setOrgFee(
    @CurrentUser() actor: AuthenticatedUser,
    @Param('orgId', ParseUUIDPipe) orgId: string,
    @Body() dto: SetOrgFeeDto,
  ) {
    return this.orgService.setOrgFee(actor.userId, orgId, dto);
  }

  @Get(':orgId/fees')
  @UseGuards(JwtAccessGuard)
  listOrgFees(
    @CurrentUser() actor: AuthenticatedUser,
    @Param('orgId', ParseUUIDPipe) orgId: string,
  ) {
    return this.orgService.listOrgFees(actor.userId, orgId);
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

  // Top up a member's credit (gated by manage_org_members — see PERMISSION_API_MAP).
  @Post(':orgId/members/:userId/credit')
  topUpCredit(
    @CurrentUser() actor: AuthenticatedUser,
    @Param('orgId', ParseUUIDPipe) orgId: string,
    @Param('userId', ParseUUIDPipe) userId: string,
    @Body() dto: TopUpCreditDto,
  ) {
    return this.orgService.topUpCredit(actor.userId, orgId, userId, dto);
  }

  // Read a member's credit balance + ledger. Authenticated-only; the service
  // authorizes (self, admin, or a manage_org_members holder). Cursor-paginated.
  @Get(':orgId/members/:userId/credit')
  @UseGuards(JwtAccessGuard)
  getMemberCredit(
    @CurrentUser() actor: AuthenticatedUser,
    @Param('orgId', ParseUUIDPipe) orgId: string,
    @Param('userId', ParseUUIDPipe) userId: string,
    @Query('limit') limit?: string,
    @Query('cursor') cursor?: string,
  ) {
    return this.orgService.getMemberCredit(actor.userId, orgId, userId, limit, cursor);
  }

  // Attach or replace the bill (receipt image) on a top-up. multipart/form-data,
  // one file field. Only the image changes — the top-up info stays immutable.
  // Gated by manage_org_members (see PERMISSION_API_MAP). Covers both "attach at
  // top-up" (call POST .../credit, then this with the returned entryId) and later.
  @Put(':orgId/members/:userId/credit/:entryId/bill')
  async setTopUpBill(
    @CurrentUser() actor: AuthenticatedUser,
    @Param('orgId', ParseUUIDPipe) orgId: string,
    @Param('userId', ParseUUIDPipe) userId: string,
    @Param('entryId', ParseUUIDPipe) entryId: string,
    @Req() req: FastifyRequest,
  ) {
    const file = await readSingleUploadedFile(req, {
      allowedMimeTypes: BILL_ALLOWED_MIME_TYPES,
      maxBytes: MAX_UPLOAD_BYTES,
    });
    return this.orgService.setTopUpBill(actor.userId, orgId, userId, entryId, file);
  }

  // Presigned URL for a top-up's bill — the browser loads it directly from the bucket
  // (no bytes through the API). Authenticated-only; service authorizes self/admin/manager.
  // ?download=true forces a save dialog instead of inline rendering.
  @Get(':orgId/members/:userId/credit/:entryId/bill')
  @UseGuards(JwtAccessGuard)
  getTopUpBillUrl(
    @CurrentUser() actor: AuthenticatedUser,
    @Param('orgId', ParseUUIDPipe) orgId: string,
    @Param('userId', ParseUUIDPipe) userId: string,
    @Param('entryId', ParseUUIDPipe) entryId: string,
    @Query('download') download?: string,
  ) {
    return this.orgService.getTopUpBillUrl(
      actor.userId,
      orgId,
      userId,
      entryId,
      download === 'true',
    );
  }

  // Remove a top-up's bill (deletes the stored object). Gated by manage_org_members.
  @Delete(':orgId/members/:userId/credit/:entryId/bill')
  deleteTopUpBill(
    @CurrentUser() actor: AuthenticatedUser,
    @Param('orgId', ParseUUIDPipe) orgId: string,
    @Param('userId', ParseUUIDPipe) userId: string,
    @Param('entryId', ParseUUIDPipe) entryId: string,
  ) {
    return this.orgService.deleteTopUpBill(actor.userId, orgId, userId, entryId);
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
