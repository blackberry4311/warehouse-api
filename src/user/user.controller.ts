import { Body, Controller, Get, ParseUUIDPipe, Patch, Query, UseGuards } from '@nestjs/common';
import { JwtAccessGuard } from '../auth/guards/jwt-access.guard';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { AuthenticatedUser } from '../auth/interfaces/jwt-payload.interface';
import { UserService } from './user.service';
import { UpdateProfileDto } from './dto/update-profile.dto';
import { parseLedgerFilters, parseTimeZone } from '../common/credit-ledger.util';

/**
 * Self-service endpoints for the authenticated user, scoped entirely to `/me`.
 *
 * Authenticated-only: these routes are intentionally NOT in PERMISSION_API_MAP, so
 * the global PermissionsGuard treats them as public and passes through;
 * `JwtAccessGuard` then enforces auth and sets `req.user`. Every action targets the
 * caller's own id, so no permission (or cross-user check) is required. Contrast with
 * the admin-facing `PATCH /organizations/users/:userId` (gated by `add_user`) and
 * `GET /organizations/:orgId/members/:userId/credit` (a manager's org-scoped view).
 */
@Controller('users')
@UseGuards(JwtAccessGuard)
export class UserController {
  constructor(private readonly userService: UserService) {}

  // The global user directory (non-admins only), each row carrying the orgs the
  // user belongs to. Unlike the /me routes, this one IS permission-gated: it is
  // listed in PERMISSION_API_MAP under `manage_all_users`, so the global
  // PermissionsGuard requires that permission (admins bypass) before the
  // controller-level JwtAccessGuard runs. Cursor-paginated; optional ?search=
  // over email/displayName/code.
  @Get()
  listUsers(
    @Query('limit') limit?: string,
    @Query('cursor') cursor?: string,
    @Query('search') search?: string,
  ) {
    return this.userService.listUsers(limit, cursor, search);
  }

  @Get('me')
  getMyProfile(@CurrentUser() user: AuthenticatedUser) {
    return this.userService.getProfile(user.userId);
  }

  @Patch('me')
  updateMyProfile(@CurrentUser() user: AuthenticatedUser, @Body() dto: UpdateProfileDto) {
    return this.userService.updateProfile(user.userId, dto);
  }

  // The caller's wallet balance + their global credit ledger (all orgs),
  // newest first and cursor-paginated (limit/cursor). Optional filters: ?type=
  // (comma-separated entry types), ?from= / ?to= (dates, to exclusive), ?orgId=.
  @Get('me/credit')
  getMyCredit(
    @CurrentUser() user: AuthenticatedUser,
    @Query('limit') limit?: string,
    @Query('cursor') cursor?: string,
    @Query('type') type?: string,
    @Query('from') from?: string,
    @Query('to') to?: string,
    @Query('orgId', new ParseUUIDPipe({ optional: true })) orgId?: string,
  ) {
    const filters = parseLedgerFilters({ type, from, to, orgId });
    return this.userService.getMyCredit(user.userId, filters, limit, cursor);
  }

  // Per-day totals (spent / added / count / closing balance) over the caller's
  // ledger, bucketed by calendar day in ?tz= (IANA, default UTC), with the same
  // optional type/from/to/orgId filters.
  @Get('me/credit/daily')
  getMyCreditDaily(
    @CurrentUser() user: AuthenticatedUser,
    @Query('type') type?: string,
    @Query('from') from?: string,
    @Query('to') to?: string,
    @Query('orgId', new ParseUUIDPipe({ optional: true })) orgId?: string,
    @Query('tz') tz?: string,
  ) {
    return this.userService.getMyCreditDaily(
      user.userId,
      parseLedgerFilters({ type, from, to, orgId }),
      parseTimeZone(tz),
    );
  }

  // Wallet summary cards: per-entry-type totals + net spent / topped up over the
  // caller's ledger, with the same optional type/from/to/orgId filters.
  @Get('me/credit/summary')
  getMyCreditSummary(
    @CurrentUser() user: AuthenticatedUser,
    @Query('type') type?: string,
    @Query('from') from?: string,
    @Query('to') to?: string,
    @Query('orgId', new ParseUUIDPipe({ optional: true })) orgId?: string,
  ) {
    return this.userService.getMyCreditSummary(
      user.userId,
      parseLedgerFilters({ type, from, to, orgId }),
    );
  }
}
