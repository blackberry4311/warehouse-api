import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ShipmentController } from './shipment.controller';
import { ShipmentService } from './shipment.service';
import { ShipmentLabelCleanupService } from './shipment-label-cleanup.service';
import { Shipment } from '../entities/shipment.entity';
import { ShipmentDetail } from '../entities/shipment-detail.entity';
import { ShipmentHistory } from '../entities/shipment-history.entity';
import { ShipmentLabel } from '../entities/shipment-label.entity';
import { TotalFee } from '../entities/total-fee.entity';
import { OrganizationModule } from '../organization/organization.module';

@Module({
  imports: [
    // OrderDetail writes (per-line stock deduction on lock) go through the shared
    // transaction EntityManager, which already knows every globally-registered entity.
    // TotalFee is read to total up a shipment's fees for the detail view; ShipmentLabel
    // holds the printable shipping-label image.
    TypeOrmModule.forFeature([Shipment, ShipmentDetail, ShipmentHistory, ShipmentLabel, TotalFee]),
    // Reuse org validation / membership checks / permission checks / code resolution.
    OrganizationModule,
  ],
  controllers: [ShipmentController],
  // ShipmentLabelCleanupService runs the daily @Cron that expires labels on closed shipments.
  providers: [ShipmentService, ShipmentLabelCleanupService],
})
export class ShipmentModule {}
