import {
  Controller,
  Get,
  ParseBoolPipe,
  ParseUUIDPipe,
  Param,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { JwtAccessGuard } from '../auth/guards/jwt-access.guard';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { AuthenticatedUser } from '../auth/interfaces/jwt-payload.interface';
import { NotificationService } from './notification.service';

/**
 * The caller's own in-app notifications. Authenticated-only (not in
 * `PERMISSION_API_MAP`): every route is scoped to the token's user.
 */
@Controller('notifications')
@UseGuards(JwtAccessGuard)
export class NotificationController {
  constructor(private readonly notificationService: NotificationService) {}

  // Newest first, cursor-paginated. Optional ?orgId= and ?unread=true.
  @Get()
  listMine(
    @CurrentUser() actor: AuthenticatedUser,
    @Query('orgId', new ParseUUIDPipe({ optional: true })) orgId?: string,
    @Query('unread', new ParseBoolPipe({ optional: true })) unread?: boolean,
    @Query('limit') limit?: string,
    @Query('cursor') cursor?: string,
  ) {
    return this.notificationService.listMine(actor.userId, { orgId, unread }, limit, cursor);
  }

  // Badge count. Declared before any :notificationId route.
  @Get('unread-count')
  unreadCount(
    @CurrentUser() actor: AuthenticatedUser,
    @Query('orgId', new ParseUUIDPipe({ optional: true })) orgId?: string,
  ) {
    return this.notificationService.unreadCount(actor.userId, orgId);
  }

  @Post('read-all')
  markAllRead(
    @CurrentUser() actor: AuthenticatedUser,
    @Query('orgId', new ParseUUIDPipe({ optional: true })) orgId?: string,
  ) {
    return this.notificationService.markAllRead(actor.userId, orgId);
  }

  @Post(':notificationId/read')
  markRead(
    @CurrentUser() actor: AuthenticatedUser,
    @Param('notificationId', ParseUUIDPipe) notificationId: string,
  ) {
    return this.notificationService.markRead(actor.userId, notificationId);
  }
}
