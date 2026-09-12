import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { UserController } from './user.controller';
import { UserService } from './user.service';
import { User } from '../entities/user.entity';
import { CreditHistory } from '../entities/credit-history.entity';

@Module({
  imports: [TypeOrmModule.forFeature([User, CreditHistory])],
  controllers: [UserController],
  providers: [UserService],
})
export class UserModule {}
