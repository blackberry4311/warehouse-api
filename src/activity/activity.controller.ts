import { Controller, Get, ParseUUIDPipe, Query } from '@nestjs/common';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { AuthenticatedUser } from '../auth/interfaces/jwt-payload.interface';
import { ActivityService, parseActivityFilters } from './activity.service';

/**
 * The system-wide activity feed: every order / shipment change and balance movement
 * in an org. Gated by `view_activity_log` (see `PERMISSION_API_MAP`).
 */
@Controller('activity')
export class ActivityController {
  constructor(private readonly activityService: ActivityService) {}

  // Newest first, cursor-paginated. Optional filters: ?action= (comma-separated),
  // ?entityType= + ?entityId= (one order/shipment/credit entry), ?actorId= (who did
  // it), ?subjectUserId= (whose order/shipment/balance it was), ?from= / ?to=.
  @Get()
  listActivity(
    @CurrentUser() actor: AuthenticatedUser,
    @Query('orgId', ParseUUIDPipe) orgId: string,
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
