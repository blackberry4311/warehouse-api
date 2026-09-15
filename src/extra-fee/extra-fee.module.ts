import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { OrderFeeController, ShipmentFeeController } from './extra-fee.controller';
import { ExtraFeeService } from './extra-fee.service';
import { ExtraFee } from '../entities/extra-fee.entity';
import { Order } from '../entities/order.entity';
import { Shipment } from '../entities/shipment.entity';
import { OrganizationModule } from '../organization/organization.module';

@Module({
  imports: [
    // ExtraFee for its own writes; Order/Shipment to load + authorize the target.
    // CreditHistory/User writes go through the shared transaction EntityManager,
    // which already knows every globally-registered entity.
    TypeOrmModule.forFeature([ExtraFee, Order, Shipment]),
    // Reuse org membership + permission checks.
    OrganizationModule,
  ],
  controllers: [OrderFeeController, ShipmentFeeController],
  providers: [ExtraFeeService],
})
export class ExtraFeeModule {}
