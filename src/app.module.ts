import { Module } from '@nestjs/common';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import { User } from './entities/user.entity';
import { RefreshToken } from './entities/refresh-token.entity';
import { Organization } from './entities/organization.entity';
import { UserOrg } from './entities/user-org.entity';
import { OrgGroup } from './entities/org-group.entity';
import { Permission } from './entities/permission.entity';
import { UserGroup } from './entities/user-group.entity';
import { GroupPermission } from './entities/group-permission.entity';
import { Order } from './entities/order.entity';
import { OrderDetail } from './entities/order-detail.entity';
import { OrderHistory } from './entities/order-history.entity';
import { OrderSequence } from './entities/order-sequence.entity';
import { OrgFee } from './entities/org-fee.entity';
import { CreditHistory } from './entities/credit-history.entity';
import { CreditResource } from './entities/credit-resource.entity';
import { Shipment } from './entities/shipment.entity';
import { ShipmentDetail } from './entities/shipment-detail.entity';
import { ShipmentHistory } from './entities/shipment-history.entity';
import { ShipmentSequence } from './entities/shipment-sequence.entity';
import { TotalFee } from './entities/total-fee.entity';
import { AuthModule } from './auth/auth.module';
import { OrganizationModule } from './organization/organization.module';
import { RbacModule } from './rbac/rbac.module';
import { OrderModule } from './order/order.module';
import { ShipmentModule } from './shipment/shipment.module';
import { ExtraFeeModule } from './extra-fee/extra-fee.module';
import { UserModule } from './user/user.module';
import { StorageModule } from './storage/storage.module';
import { ScheduleModule } from '@nestjs/schedule';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    ScheduleModule.forRoot(),
    StorageModule,
    TypeOrmModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        type: 'postgres',
        url: config.get('DATABASE_URL'),
        schema: 'wh',
        entities: [
          User,
          RefreshToken,
          Organization,
          UserOrg,
          OrgGroup,
          Permission,
          UserGroup,
          GroupPermission,
          Order,
          OrderDetail,
          OrderHistory,
          OrderSequence,
          OrgFee,
          CreditHistory,
          CreditResource,
          Shipment,
          ShipmentDetail,
          ShipmentHistory,
          ShipmentSequence,
          TotalFee,
        ],
        synchronize: false,
      }),
    }),
    TypeOrmModule.forFeature([User, RefreshToken]),
    AuthModule,
    OrganizationModule,
    RbacModule,
    OrderModule,
    ShipmentModule,
    ExtraFeeModule,
    UserModule,
  ],
  exports: [TypeOrmModule],
  controllers: [AppController],
  providers: [AppService],
})
export class AppModule {}
