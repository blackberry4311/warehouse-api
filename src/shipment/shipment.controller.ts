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
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { AuthenticatedUser } from '../auth/interfaces/jwt-payload.interface';
import { JwtAccessGuard } from '../auth/guards/jwt-access.guard';
import { MAX_UPLOAD_BYTES, readSingleUploadedFile } from '../common/uploaded-file.util';
import { LABEL_ALLOWED_MIME_TYPES } from '../common/shipment-label.util';
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
    return this.shipmentService.getShipmentDetail(actor.userId, shipmentId);
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

  // Attach or replace the shipping label (printable image). multipart/form-data, one
  // file field. Gated by place_shipment (see PERMISSION_API_MAP); the service re-checks
  // ownership and that the shipment is not terminal.
  @Put(':shipmentId/label')
  async setLabel(
    @CurrentUser() actor: AuthenticatedUser,
    @Param('shipmentId', ParseUUIDPipe) shipmentId: string,
    @Req() req: FastifyRequest,
  ) {
    const file = await readSingleUploadedFile(req, {
      allowedMimeTypes: LABEL_ALLOWED_MIME_TYPES,
      maxBytes: MAX_UPLOAD_BYTES,
    });
    return this.shipmentService.setLabel(actor.userId, shipmentId, file);
  }

  // Presigned URL for a shipment's label — the browser / print machine loads it directly
  // from the bucket (no bytes through the API). Authenticated-only; the service authorizes
  // via shipment visibility. ?download=true forces a save dialog instead of inline render.
  @Get(':shipmentId/label')
  @UseGuards(JwtAccessGuard)
  getLabelUrl(
    @CurrentUser() actor: AuthenticatedUser,
    @Param('shipmentId', ParseUUIDPipe) shipmentId: string,
    @Query('download') download?: string,
  ) {
    return this.shipmentService.getLabelUrl(actor.userId, shipmentId, download === 'true');
  }

  // Remove a shipment's label (deletes the stored object). Gated by place_shipment.
  @Delete(':shipmentId/label')
  deleteLabel(
    @CurrentUser() actor: AuthenticatedUser,
    @Param('shipmentId', ParseUUIDPipe) shipmentId: string,
  ) {
    return this.shipmentService.deleteLabel(actor.userId, shipmentId);
  }
}
