import { Body, Controller, Delete, Get, Param, ParseUUIDPipe, Post, Query } from '@nestjs/common';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { AuthenticatedUser } from '../auth/interfaces/jwt-payload.interface';
import { ExtraFeeService } from './extra-fee.service';
import { CreateExtraFeeDto } from './dto/create-extra-fee.dto';

/**
 * Ad-hoc extra fees on an order. Adding/voiding is staff-only (`review_order` |
 * `process_order`); listing is reachable by those plus the placing client
 * (`place_order`), scoped in the service. Auth/permissions come from the global
 * `PermissionsGuard` via `PERMISSION_API_MAP`, like the other order routes.
 */
@Controller('orders')
export class OrderFeeController {
  constructor(private readonly extraFeeService: ExtraFeeService) {}

  @Post(':orderId/fees')
  add(
    @CurrentUser() actor: AuthenticatedUser,
    @Param('orderId', ParseUUIDPipe) orderId: string,
    @Body() dto: CreateExtraFeeDto,
  ) {
    return this.extraFeeService.addOrderFee(actor.userId, orderId, dto);
  }

  @Get(':orderId/fees')
  list(
    @CurrentUser() actor: AuthenticatedUser,
    @Param('orderId', ParseUUIDPipe) orderId: string,
    @Query('limit') limit?: string,
    @Query('cursor') cursor?: string,
  ) {
    return this.extraFeeService.listOrderFees(actor.userId, orderId, limit, cursor);
  }

  @Delete(':orderId/fees/:feeId')
  void(
    @CurrentUser() actor: AuthenticatedUser,
    @Param('orderId', ParseUUIDPipe) orderId: string,
    @Param('feeId', ParseUUIDPipe) feeId: string,
  ) {
    return this.extraFeeService.voidOrderFee(actor.userId, orderId, feeId);
  }
}

/**
 * Ad-hoc extra fees on a shipment — the mirror of {@link OrderFeeController}, gated
 * by the shipment role permissions (`review_shipment` | `process_shipment`, plus
 * `place_shipment` for listing).
 */
@Controller('shipments')
export class ShipmentFeeController {
  constructor(private readonly extraFeeService: ExtraFeeService) {}

  @Post(':shipmentId/fees')
  add(
    @CurrentUser() actor: AuthenticatedUser,
    @Param('shipmentId', ParseUUIDPipe) shipmentId: string,
    @Body() dto: CreateExtraFeeDto,
  ) {
    return this.extraFeeService.addShipmentFee(actor.userId, shipmentId, dto);
  }

  @Get(':shipmentId/fees')
  list(
    @CurrentUser() actor: AuthenticatedUser,
    @Param('shipmentId', ParseUUIDPipe) shipmentId: string,
    @Query('limit') limit?: string,
    @Query('cursor') cursor?: string,
  ) {
    return this.extraFeeService.listShipmentFees(actor.userId, shipmentId, limit, cursor);
  }

  @Delete(':shipmentId/fees/:feeId')
  void(
    @CurrentUser() actor: AuthenticatedUser,
    @Param('shipmentId', ParseUUIDPipe) shipmentId: string,
    @Param('feeId', ParseUUIDPipe) feeId: string,
  ) {
    return this.extraFeeService.voidShipmentFee(actor.userId, shipmentId, feeId);
  }
}
