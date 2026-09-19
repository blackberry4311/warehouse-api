import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { InventoryController } from './inventory.controller';
import { InventoryService } from './inventory.service';
import { OrderDetail } from '../entities/order-detail.entity';
import { OrganizationModule } from '../organization/organization.module';

/**
 * Read-only view over warehoused inventory (RECEIVED order line items with stock
 * left). Standalone module, mirroring OrderModule/ShipmentModule: it reads
 * `order_details` and reuses `OrganizationService` (org existence, membership,
 * permission checks) for authorization and row-level scoping.
 */
@Module({
  imports: [TypeOrmModule.forFeature([OrderDetail]), OrganizationModule],
  controllers: [InventoryController],
  providers: [InventoryService],
})
export class InventoryModule {}
