import { Controller, Get, ParseUUIDPipe, Query, UseGuards } from '@nestjs/common';
import { JwtAccessGuard } from '../auth/guards/jwt-access.guard';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { AuthenticatedUser } from '../auth/interfaces/jwt-payload.interface';
import { parseTimeZone } from '../common/credit-ledger.util';
import { parseReportFilters, parseTopClientMetric, ReportService } from './report.service';

/**
 * Dashboard / report aggregates over orders, shipments, inventory and credit.
 * Authenticated-only (not in `PERMISSION_API_MAP`): every user gets a report over
 * their own rows in the orgs they belong to; `view_all_report` widens it to every org
 * and user (see `ReportService.resolveScope`).
 *
 * Every route takes the optional ?orgId= / ?userId= (narrow the scope) and
 * ?from= (inclusive) / ?to= (exclusive) filters; the daily routes also take ?tz=
 * (IANA, default UTC).
 */
@Controller('reports')
@UseGuards(JwtAccessGuard)
export class ReportController {
  constructor(private readonly reportService: ReportService) {}

  @Get('overview')
  getOverview(
    @CurrentUser() actor: AuthenticatedUser,
    @Query('orgId', new ParseUUIDPipe({ optional: true })) orgId?: string,
    @Query('userId', new ParseUUIDPipe({ optional: true })) userId?: string,
    @Query('from') from?: string,
    @Query('to') to?: string,
  ) {
    return this.reportService.getOverview(
      actor.userId,
      parseReportFilters({ orgId, userId, from, to }),
    );
  }

  @Get('orders/daily')
  getOrdersDaily(
    @CurrentUser() actor: AuthenticatedUser,
    @Query('orgId', new ParseUUIDPipe({ optional: true })) orgId?: string,
    @Query('userId', new ParseUUIDPipe({ optional: true })) userId?: string,
    @Query('from') from?: string,
    @Query('to') to?: string,
    @Query('tz') tz?: string,
  ) {
    return this.reportService.getOrdersDaily(
      actor.userId,
      parseReportFilters({ orgId, userId, from, to }),
      parseTimeZone(tz),
    );
  }

  @Get('shipments/daily')
  getShipmentsDaily(
    @CurrentUser() actor: AuthenticatedUser,
    @Query('orgId', new ParseUUIDPipe({ optional: true })) orgId?: string,
    @Query('userId', new ParseUUIDPipe({ optional: true })) userId?: string,
    @Query('from') from?: string,
    @Query('to') to?: string,
    @Query('tz') tz?: string,
  ) {
    return this.reportService.getShipmentsDaily(
      actor.userId,
      parseReportFilters({ orgId, userId, from, to }),
      parseTimeZone(tz),
    );
  }

  @Get('credit/daily')
  getCreditDaily(
    @CurrentUser() actor: AuthenticatedUser,
    @Query('orgId', new ParseUUIDPipe({ optional: true })) orgId?: string,
    @Query('userId', new ParseUUIDPipe({ optional: true })) userId?: string,
    @Query('from') from?: string,
    @Query('to') to?: string,
    @Query('tz') tz?: string,
  ) {
    return this.reportService.getCreditDaily(
      actor.userId,
      parseReportFilters({ orgId, userId, from, to }),
      parseTimeZone(tz),
    );
  }

  // ?metric= orders (default) | shipments | spent; ?limit= (default 10, max 50).
  @Get('top-clients')
  getTopClients(
    @CurrentUser() actor: AuthenticatedUser,
    @Query('orgId', new ParseUUIDPipe({ optional: true })) orgId?: string,
    @Query('userId', new ParseUUIDPipe({ optional: true })) userId?: string,
    @Query('from') from?: string,
    @Query('to') to?: string,
    @Query('metric') metric?: string,
    @Query('limit') limit?: string,
  ) {
    return this.reportService.getTopClients(
      actor.userId,
      parseReportFilters({ orgId, userId, from, to }),
      parseTopClientMetric(metric),
      limit,
    );
  }
}
