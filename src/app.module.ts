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
import { OrderHistory } from './entities/order-history.entity';
import { OrderSequence } from './entities/order-sequence.entity';
import { AuthModule } from './auth/auth.module';
import { OrganizationModule } from './organization/organization.module';
import { OrderModule } from './order/order.module';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
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
          OrderHistory,
          OrderSequence,
        ],
        synchronize: false,
      }),
    }),
    TypeOrmModule.forFeature([User, RefreshToken]),
    AuthModule,
    OrganizationModule,
    OrderModule,
  ],
  exports: [TypeOrmModule],
  controllers: [AppController],
  providers: [AppService],
})
export class AppModule {}
