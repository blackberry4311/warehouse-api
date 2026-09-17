import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { AuthenticatedUser } from '../auth/interfaces/jwt-payload.interface';
import { OrderService } from './order.service';
import { PlaceOrderDto } from './dto/place-order.dto';
import { UpdateOrderDto } from './dto/update-order.dto';
import { UpdateOrderStatusDto } from './dto/update-order-status.dto';
import { AddOrderDetailDto } from './dto/add-order-detail.dto';
import { UpdateOrderDetailDto } from './dto/update-order-detail.dto';
import { UpdateOrderDetailStatusDto } from './dto/update-order-detail-status.dto';
import { LockOrderDto } from './dto/lock-order.dto';

@Controller('orders')
export class OrderController {
  constructor(private readonly orderService: OrderService) {}

  @Post()
  placeOrder(@CurrentUser() actor: AuthenticatedUser, @Body() dto: PlaceOrderDto) {
    return this.orderService.placeOrder(actor.userId, dto);
  }

  @Get()
  listOrders(
    @CurrentUser() actor: AuthenticatedUser,
    @Query('orgId', ParseUUIDPipe) orgId: string,
    @Query('limit') limit?: string,
    @Query('cursor') cursor?: string,
    @Query('status') status?: string,
    @Query('search') search?: string,
    @Query('locked') locked?: string,
  ) {
    return this.orderService.listOrders(actor.userId, orgId, limit, cursor, status, search, locked);
  }

  @Get(':orderId')
  getOrder(
    @CurrentUser() actor: AuthenticatedUser,
    @Param('orderId', ParseUUIDPipe) orderId: string,
  ) {
    return this.orderService.getOrderDetail(actor.userId, orderId);
  }

  @Patch(':orderId')
  updateOrder(
    @CurrentUser() actor: AuthenticatedUser,
    @Param('orderId', ParseUUIDPipe) orderId: string,
    @Body() dto: UpdateOrderDto,
  ) {
    return this.orderService.updateOrder(actor.userId, orderId, dto);
  }

  @Post(':orderId/details')
  addDetail(
    @CurrentUser() actor: AuthenticatedUser,
    @Param('orderId', ParseUUIDPipe) orderId: string,
    @Body() dto: AddOrderDetailDto,
  ) {
    return this.orderService.addDetail(actor.userId, orderId, dto);
  }

  @Patch(':orderId/details/:detailId')
  updateDetail(
    @CurrentUser() actor: AuthenticatedUser,
    @Param('orderId', ParseUUIDPipe) orderId: string,
    @Param('detailId', ParseUUIDPipe) detailId: string,
    @Body() dto: UpdateOrderDetailDto,
  ) {
    return this.orderService.updateDetail(actor.userId, orderId, detailId, dto);
  }

  @Patch(':orderId/details/:detailId/status')
  updateDetailStatus(
    @CurrentUser() actor: AuthenticatedUser,
    @Param('orderId', ParseUUIDPipe) orderId: string,
    @Param('detailId', ParseUUIDPipe) detailId: string,
    @Body() dto: UpdateOrderDetailStatusDto,
  ) {
    return this.orderService.updateDetailStatus(actor.userId, orderId, detailId, dto);
  }

  @Delete(':orderId/details/:detailId')
  removeDetail(
    @CurrentUser() actor: AuthenticatedUser,
    @Param('orderId', ParseUUIDPipe) orderId: string,
    @Param('detailId', ParseUUIDPipe) detailId: string,
  ) {
    return this.orderService.removeDetail(actor.userId, orderId, detailId);
  }

  @Post(':orderId/lock')
  lockOrder(
    @CurrentUser() actor: AuthenticatedUser,
    @Param('orderId', ParseUUIDPipe) orderId: string,
    @Body() dto: LockOrderDto,
  ) {
    return this.orderService.lockOrder(actor.userId, orderId, dto);
  }

  @Patch(':orderId/status')
  updateStatus(
    @CurrentUser() actor: AuthenticatedUser,
    @Param('orderId', ParseUUIDPipe) orderId: string,
    @Body() dto: UpdateOrderStatusDto,
  ) {
    return this.orderService.updateStatus(actor.userId, orderId, dto);
  }

  @Get(':orderId/history')
  getHistory(
    @CurrentUser() actor: AuthenticatedUser,
    @Param('orderId', ParseUUIDPipe) orderId: string,
    @Query('limit') limit?: string,
    @Query('cursor') cursor?: string,
  ) {
    return this.orderService.getHistory(actor.userId, orderId, limit, cursor);
  }
}
