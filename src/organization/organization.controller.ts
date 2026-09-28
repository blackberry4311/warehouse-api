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
import { parseLedgerFilters, parseTimeZone } from '../common/credit-ledger.util';
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
import { AdjustCreditDto } from './dto/adjust-credit.dto';
import { CreateCreditGroupDto } from './dto/create-credit-group.dto';
import { UpdateCreditGroupDto } from './dto/update-credit-group.dto';
import { SetCreditGroupFeeDto } from './dto/set-credit-group-fee.dto';
import { AddCreditGroupMemberDto } from './dto/add-credit-group-member.dto';

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

  // --- Credit groups (system-admin only) -----------------------------------
  // Billing construct: a set of clients whose lock fee is marked up, with an owner
  // who earns (group fee − org fee). Not in PERMISSION_API_MAP; the service enforces
  // is_admin, like org fees.

  @Post(':orgId/credit-groups')
  @UseGuards(JwtAccessGuard)
  createCreditGroup(
    @CurrentUser() actor: AuthenticatedUser,
    @Param('orgId', ParseUUIDPipe) orgId: string,
    @Body() dto: CreateCreditGroupDto,
  ) {
    return this.orgService.createCreditGroup(actor.userId, orgId, dto);
  }

  @Get(':orgId/credit-groups')
  @UseGuards(JwtAccessGuard)
  listCreditGroups(
    @CurrentUser() actor: AuthenticatedUser,
    @Param('orgId', ParseUUIDPipe) orgId: string,
  ) {
    return this.orgService.listCreditGroups(actor.userId, orgId);
  }

  @Get(':orgId/credit-groups/:creditGroupId')
  @UseGuards(JwtAccessGuard)
  getCreditGroup(
    @CurrentUser() actor: AuthenticatedUser,
    @Param('orgId', ParseUUIDPipe) orgId: string,
    @Param('creditGroupId', ParseUUIDPipe) creditGroupId: string,
  ) {
    return this.orgService.getCreditGroup(actor.userId, orgId, creditGroupId);
  }

  @Patch(':orgId/credit-groups/:creditGroupId')
  @UseGuards(JwtAccessGuard)
  updateCreditGroup(
    @CurrentUser() actor: AuthenticatedUser,
    @Param('orgId', ParseUUIDPipe) orgId: string,
    @Param('creditGroupId', ParseUUIDPipe) creditGroupId: string,
    @Body() dto: UpdateCreditGroupDto,
  ) {
    return this.orgService.updateCreditGroup(actor.userId, orgId, creditGroupId, dto);
  }

  @Delete(':orgId/credit-groups/:creditGroupId')
  @UseGuards(JwtAccessGuard)
  deleteCreditGroup(
    @CurrentUser() actor: AuthenticatedUser,
    @Param('orgId', ParseUUIDPipe) orgId: string,
    @Param('creditGroupId', ParseUUIDPipe) creditGroupId: string,
  ) {
    return this.orgService.deleteCreditGroup(actor.userId, orgId, creditGroupId);
  }

  @Post(':orgId/credit-groups/:creditGroupId/fees')
  @UseGuards(JwtAccessGuard)
  setCreditGroupFee(
    @CurrentUser() actor: AuthenticatedUser,
    @Param('orgId', ParseUUIDPipe) orgId: string,
    @Param('creditGroupId', ParseUUIDPipe) creditGroupId: string,
    @Body() dto: SetCreditGroupFeeDto,
  ) {
    return this.orgService.setCreditGroupFee(actor.userId, orgId, creditGroupId, dto);
  }

  @Get(':orgId/credit-groups/:creditGroupId/fees')
  @UseGuards(JwtAccessGuard)
  listCreditGroupFees(
    @CurrentUser() actor: AuthenticatedUser,
    @Param('orgId', ParseUUIDPipe) orgId: string,
    @Param('creditGroupId', ParseUUIDPipe) creditGroupId: string,
  ) {
    return this.orgService.listCreditGroupFees(actor.userId, orgId, creditGroupId);
  }

  @Post(':orgId/credit-groups/:creditGroupId/members')
  @UseGuards(JwtAccessGuard)
  addCreditGroupMember(
    @CurrentUser() actor: AuthenticatedUser,
    @Param('orgId', ParseUUIDPipe) orgId: string,
    @Param('creditGroupId', ParseUUIDPipe) creditGroupId: string,
    @Body() dto: AddCreditGroupMemberDto,
  ) {
    return this.orgService.addCreditGroupMember(actor.userId, orgId, creditGroupId, dto);
  }

  @Get(':orgId/credit-groups/:creditGroupId/members')
  @UseGuards(JwtAccessGuard)
  listCreditGroupMembers(
    @CurrentUser() actor: AuthenticatedUser,
    @Param('orgId', ParseUUIDPipe) orgId: string,
    @Param('creditGroupId', ParseUUIDPipe) creditGroupId: string,
  ) {
    return this.orgService.listCreditGroupMembers(actor.userId, orgId, creditGroupId);
  }

  @Delete(':orgId/credit-groups/:creditGroupId/members/:userId')
  @UseGuards(JwtAccessGuard)
  removeCreditGroupMember(
    @CurrentUser() actor: AuthenticatedUser,
    @Param('orgId', ParseUUIDPipe) orgId: string,
    @Param('creditGroupId', ParseUUIDPipe) creditGroupId: string,
    @Param('userId', ParseUUIDPipe) userId: string,
  ) {
    return this.orgService.removeCreditGroupMember(actor.userId, orgId, creditGroupId, userId);
  }

  // --- Membership ----------------------------------------------------------

  @Post(':orgId/members')
  addMember(@Param('orgId', ParseUUIDPipe) orgId: string, @Body() dto: AddMemberDto) {
    return this.orgService.addMember(orgId, dto.userId);
  }

  // Members with their groups. Each `user` carries safe columns only; `credit` is
  // included only for view_user_balances / manage_user_balances holders.
  @Get(':orgId/members')
  listMembers(
    @CurrentUser() actor: AuthenticatedUser,
    @Param('orgId', ParseUUIDPipe) orgId: string,
  ) {
    return this.orgService.listMembers(actor.userId, orgId);
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

  // Top up a member's credit (gated by manage_user_balances — see PERMISSION_API_MAP).
  @Post(':orgId/members/:userId/credit')
  topUpCredit(
    @CurrentUser() actor: AuthenticatedUser,
    @Param('orgId', ParseUUIDPipe) orgId: string,
    @Param('userId', ParseUUIDPipe) userId: string,
    @Body() dto: TopUpCreditDto,
  ) {
    return this.orgService.topUpCredit(actor.userId, orgId, userId, dto);
  }

  // The org's whole credit ledger (every member's entries in this org), newest
  // first, cursor-paginated. Optional ?type= / ?from= / ?to= / ?userId= filters.
  // Gated by view_user_balances or manage_user_balances (see PERMISSION_API_MAP).
  @Get(':orgId/credit/ledger')
  listOrgLedger(
    @CurrentUser() actor: AuthenticatedUser,
    @Param('orgId', ParseUUIDPipe) orgId: string,
    @Query('limit') limit?: string,
    @Query('cursor') cursor?: string,
    @Query('type') type?: string,
    @Query('from') from?: string,
    @Query('to') to?: string,
    @Query('userId', new ParseUUIDPipe({ optional: true })) userId?: string,
  ) {
    const filters = parseLedgerFilters({ type, from, to, userId });
    return this.orgService.listOrgLedger(actor.userId, orgId, filters, limit, cursor);
  }

  // Totals over the org's whole ledger, same filters (no paging).
  @Get(':orgId/credit/summary')
  getOrgCreditSummary(
    @CurrentUser() actor: AuthenticatedUser,
    @Param('orgId', ParseUUIDPipe) orgId: string,
    @Query('type') type?: string,
    @Query('from') from?: string,
    @Query('to') to?: string,
    @Query('userId', new ParseUUIDPipe({ optional: true })) userId?: string,
  ) {
    return this.orgService.getOrgCreditSummary(
      actor.userId,
      orgId,
      parseLedgerFilters({ type, from, to, userId }),
    );
  }

  // The org's whole ledger rolled up per calendar day in ?tz= (IANA, default UTC),
  // same filters (no paging).
  @Get(':orgId/credit/daily')
  getOrgCreditDaily(
    @CurrentUser() actor: AuthenticatedUser,
    @Param('orgId', ParseUUIDPipe) orgId: string,
    @Query('type') type?: string,
    @Query('from') from?: string,
    @Query('to') to?: string,
    @Query('userId', new ParseUUIDPipe({ optional: true })) userId?: string,
    @Query('tz') tz?: string,
  ) {
    return this.orgService.getOrgCreditDaily(
      actor.userId,
      orgId,
      parseLedgerFilters({ type, from, to, userId }),
      parseTimeZone(tz),
    );
  }

  // Manually correct a member's credit by a signed amount with a required note
  // (ADJUSTMENT ledger row). Gated by manage_user_balances (see PERMISSION_API_MAP).
  @Post(':orgId/members/:userId/credit/adjustments')
  adjustCredit(
    @CurrentUser() actor: AuthenticatedUser,
    @Param('orgId', ParseUUIDPipe) orgId: string,
    @Param('userId', ParseUUIDPipe) userId: string,
    @Body() dto: AdjustCreditDto,
  ) {
    return this.orgService.adjustCredit(actor.userId, orgId, userId, dto);
  }

  // Every member's wallet balance plus their spend / top-ups in this org (optional
  // ?from= / ?to= window) and org-wide totals. Gated by view_user_balances or
  // manage_user_balances (see PERMISSION_API_MAP).
  @Get(':orgId/credit/balances')
  listMemberBalances(
    @CurrentUser() actor: AuthenticatedUser,
    @Param('orgId', ParseUUIDPipe) orgId: string,
    @Query('from') from?: string,
    @Query('to') to?: string,
  ) {
    return this.orgService.listMemberBalances(
      actor.userId,
      orgId,
      parseLedgerFilters({ from, to }),
    );
  }

  // Read a member's credit balance + ledger. Authenticated-only; the service
  // authorizes (self, admin, or a view_user_balances / manage_user_balances holder).
  // Cursor-paginated.
  // Optional filters: ?type= (comma-separated entry types), ?from= / ?to= (to exclusive).
  @Get(':orgId/members/:userId/credit')
  @UseGuards(JwtAccessGuard)
  getMemberCredit(
    @CurrentUser() actor: AuthenticatedUser,
    @Param('orgId', ParseUUIDPipe) orgId: string,
    @Param('userId', ParseUUIDPipe) userId: string,
    @Query('limit') limit?: string,
    @Query('cursor') cursor?: string,
    @Query('type') type?: string,
    @Query('from') from?: string,
    @Query('to') to?: string,
  ) {
    const filters = parseLedgerFilters({ type, from, to });
    return this.orgService.getMemberCredit(actor.userId, orgId, userId, filters, limit, cursor);
  }

  // Summary totals over a member's ledger in this org (same auth as the ledger
  // read), with the same optional type/from/to filters.
  @Get(':orgId/members/:userId/credit/summary')
  @UseGuards(JwtAccessGuard)
  getMemberCreditSummary(
    @CurrentUser() actor: AuthenticatedUser,
    @Param('orgId', ParseUUIDPipe) orgId: string,
    @Param('userId', ParseUUIDPipe) userId: string,
    @Query('type') type?: string,
    @Query('from') from?: string,
    @Query('to') to?: string,
  ) {
    return this.orgService.getMemberCreditSummary(
      actor.userId,
      orgId,
      userId,
      parseLedgerFilters({ type, from, to }),
    );
  }

  // Attach or replace the bill (receipt image) on a top-up. multipart/form-data,
  // one file field. Only the image changes — the top-up info stays immutable.
  // Gated by manage_user_balances (see PERMISSION_API_MAP). Covers both "attach at
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
  // (no bytes through the API). Authenticated-only; service authorizes self/admin/balance viewer.
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

  // Remove a top-up's bill (deletes the stored object). Gated by manage_user_balances.
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
