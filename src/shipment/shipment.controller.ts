import { Body, Controller, Get, Param, ParseUUIDPipe, Patch, Post, Query } from '@nestjs/common';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { AuthenticatedUser } from '../auth/interfaces/jwt-payload.interface';
import { ShipmentService } from './shipment.service';
import { PlaceShipmentDto } from './dto/place-shipment.dto';
import { UpdateShipmentDto } from './dto/update-shipment.dto';
import { LockShipmentDto } from './dto/lock-shipment.dto';
import { UpdateShipmentStatusDto } from './dto/update-shipment-status.dto';

@Controller('shipments')
export class ShipmentController {
  constructor(private readonly shipmentService: ShipmentService) {}

  @Post()
  placeShipment(@CurrentUser() actor: AuthenticatedUser, @Body() dto: PlaceShipmentDto) {
    return this.shipmentService.placeShipment(actor.userId, dto);
  }

  @Get()
  listShipments(
    @CurrentUser() actor: AuthenticatedUser,
    @Query('orgId', ParseUUIDPipe) orgId: string,
    @Query('limit') limit?: string,
    @Query('cursor') cursor?: string,
    @Query('status') status?: string,
    @Query('search') search?: string,
    @Query('locked') locked?: string,
  ) {
    return this.shipmentService.listShipments(
      actor.userId,
      orgId,
      limit,
      cursor,
      status,
      search,
      locked,
    );
  }

  @Get(':shipmentId')
  getShipment(
    @CurrentUser() actor: AuthenticatedUser,
    @Param('shipmentId', ParseUUIDPipe) shipmentId: string,
  ) {
    return this.shipmentService.getShipment(actor.userId, shipmentId);
  }

  @Patch(':shipmentId')
  updateShipment(
    @CurrentUser() actor: AuthenticatedUser,
    @Param('shipmentId', ParseUUIDPipe) shipmentId: string,
    @Body() dto: UpdateShipmentDto,
  ) {
    return this.shipmentService.updateShipment(actor.userId, shipmentId, dto);
  }

  @Post(':shipmentId/lock')
  lockShipment(
    @CurrentUser() actor: AuthenticatedUser,
    @Param('shipmentId', ParseUUIDPipe) shipmentId: string,
    @Body() dto: LockShipmentDto,
  ) {
    return this.shipmentService.lockShipment(actor.userId, shipmentId, dto);
  }

  @Patch(':shipmentId/status')
  updateStatus(
    @CurrentUser() actor: AuthenticatedUser,
    @Param('shipmentId', ParseUUIDPipe) shipmentId: string,
    @Body() dto: UpdateShipmentStatusDto,
  ) {
    return this.shipmentService.updateStatus(actor.userId, shipmentId, dto);
  }

  @Get(':shipmentId/history')
  getHistory(
    @CurrentUser() actor: AuthenticatedUser,
    @Param('shipmentId', ParseUUIDPipe) shipmentId: string,
    @Query('limit') limit?: string,
    @Query('cursor') cursor?: string,
  ) {
    return this.shipmentService.getHistory(actor.userId, shipmentId, limit, cursor);
  }
}
