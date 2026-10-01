import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ReportController } from './report.controller';
import { ReportService } from './report.service';
import { Order } from '../entities/order.entity';
import { OrderDetail } from '../entities/order-detail.entity';
import { Shipment } from '../entities/shipment.entity';
import { CreditHistory } from '../entities/credit-history.entity';
import { UserOrg } from '../entities/user-org.entity';
import { OrganizationModule } from '../organization/organization.module';

/**
 * Read-only dashboard / report aggregates. Standalone, like InventoryModule and
 * ActivityModule: it queries the order, shipment and ledger tables directly and reuses
 * `OrganizationService` for org existence and the `view_all_report` grant.
 */
@Module({
  imports: [
    TypeOrmModule.forFeature([Order, OrderDetail, Shipment, CreditHistory, UserOrg]),
    OrganizationModule,
  ],
  controllers: [ReportController],
  providers: [ReportService],
})
export class ReportModule {}
