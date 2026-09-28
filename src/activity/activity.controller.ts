import { Controller, Get, ParseUUIDPipe, Query, UseGuards } from '@nestjs/common';
import { JwtAccessGuard } from '../auth/guards/jwt-access.guard';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { AuthenticatedUser } from '../auth/interfaces/jwt-payload.interface';
import { ActivityService, parseActivityFilters } from './activity.service';

/**
 * The system-wide activity feed: every order / shipment change and balance movement.
 * Authenticated-only: everyone sees their own rows; `view_all_activity_log` widens it
 * to every row in the orgs where it is held (see `ActivityService.listActivity`).
 */
@Controller('activity')
@UseGuards(JwtAccessGuard)
export class ActivityController {
  constructor(private readonly activityService: ActivityService) {}

  // Newest first, cursor-paginated. Optional filters: ?orgId= (one org), ?action= (comma-separated),
  // ?entityType= + ?entityId= (one order/shipment/credit entry), ?actorId= (who did
  // it), ?subjectUserId= (whose order/shipment/balance it was), ?from= / ?to=.
  @Get()
  listActivity(
    @CurrentUser() actor: AuthenticatedUser,
    @Query('orgId', new ParseUUIDPipe({ optional: true })) orgId?: string,
    @Query('limit') limit?: string,
    @Query('cursor') cursor?: string,
    @Query('action') action?: string,
    @Query('entityType') entityType?: string,
    @Query('entityId', new ParseUUIDPipe({ optional: true })) entityId?: string,
    @Query('actorId', new ParseUUIDPipe({ optional: true })) actorId?: string,
    @Query('subjectUserId', new ParseUUIDPipe({ optional: true })) subjectUserId?: string,
    @Query('from') from?: string,
    @Query('to') to?: string,
  ) {
    const filters = parseActivityFilters({
      action,
      entityType,
      entityId,
      actorId,
      subjectUserId,
      from,
      to,
    });
    return this.activityService.listActivity(actor.userId, orgId, filters, limit, cursor);
  }
}
