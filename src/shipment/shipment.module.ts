import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ShipmentController } from './shipment.controller';
import { ShipmentService } from './shipment.service';
import { Shipment } from '../entities/shipment.entity';
import { ShipmentDetail } from '../entities/shipment-detail.entity';
import { ShipmentHistory } from '../entities/shipment-history.entity';
import { OrganizationModule } from '../organization/organization.module';

@Module({
  imports: [
    // Order / OrderHistory writes (stock deduction on lock) go through the shared
    // transaction EntityManager, which already knows every globally-registered entity.
    TypeOrmModule.forFeature([Shipment, ShipmentDetail, ShipmentHistory]),
    // Reuse org validation / membership checks / permission checks / code resolution.
    OrganizationModule,
  ],
  controllers: [ShipmentController],
  providers: [ShipmentService],
})
export class ShipmentModule {}
