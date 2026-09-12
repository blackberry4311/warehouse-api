import { Body, Controller, Get, Patch, Query, UseGuards } from '@nestjs/common';
import { JwtAccessGuard } from '../auth/guards/jwt-access.guard';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { AuthenticatedUser } from '../auth/interfaces/jwt-payload.interface';
import { UserService } from './user.service';
import { UpdateProfileDto } from './dto/update-profile.dto';

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

  @Get('me')
  getMyProfile(@CurrentUser() user: AuthenticatedUser) {
    return this.userService.getProfile(user.userId);
  }

  @Patch('me')
  updateMyProfile(@CurrentUser() user: AuthenticatedUser, @Body() dto: UpdateProfileDto) {
    return this.userService.updateProfile(user.userId, dto);
  }

  // The caller's wallet balance + their global credit ledger (all orgs),
  // newest first and cursor-paginated (limit/cursor).
  @Get('me/credit')
  getMyCredit(
    @CurrentUser() user: AuthenticatedUser,
    @Query('limit') limit?: string,
    @Query('cursor') cursor?: string,
  ) {
    return this.userService.getMyCredit(user.userId, limit, cursor);
  }
}
