import { Controller, Get, ParseUUIDPipe, Query } from '@nestjs/common';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { AuthenticatedUser } from '../auth/interfaces/jwt-payload.interface';
import { InventoryService } from './inventory.service';

/**
 * Read-only inventory: the warehoused order line items (RECEIVED, with stock left)
 * a client can ship. One list endpoint; org-scoped like orders/shipments, gated by
 * the shipment permissions (see `PERMISSION_API_MAP`).
 */
@Controller('inventory')
export class InventoryController {
  constructor(private readonly inventoryService: InventoryService) {}

  @Get()
  listInventory(
    @CurrentUser() actor: AuthenticatedUser,
    @Query('orgId', ParseUUIDPipe) orgId: string,
    @Query('limit') limit?: string,
    @Query('cursor') cursor?: string,
    @Query('search') search?: string,
  ) {
    return this.inventoryService.listInventory(actor.userId, orgId, limit, cursor, search);
  }
}
