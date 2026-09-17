import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { OrderController } from './order.controller';
import { OrderService } from './order.service';
import { Order } from '../entities/order.entity';
import { OrderDetail } from '../entities/order-detail.entity';
import { OrderHistory } from '../entities/order-history.entity';
import { User } from '../entities/user.entity';
import { TotalFee } from '../entities/total-fee.entity';
import { OrganizationModule } from '../organization/organization.module';

@Module({
  imports: [
    TypeOrmModule.forFeature([Order, OrderDetail, OrderHistory, User, TotalFee]),
    // Reuse org validation / membership checks / client-code resolution.
    OrganizationModule,
  ],
  controllers: [OrderController],
  providers: [OrderService],
})
export class OrderModule {}
