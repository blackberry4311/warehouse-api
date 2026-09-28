import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ActivityLog } from '../entities/activity-log.entity';
import { Notification } from '../entities/notification.entity';
import { NotificationController } from './notification.controller';
import { NotificationListener } from './notification.listener';
import { NotificationService } from './notification.service';

/**
 * In-app notifications, fanned out from `activity_log`. Listens for
 * `activity.recorded` (emitted by ActivityModule's subscriber after commit) and
 * sweeps un-notified rows every minute. Depends on no feature module — recipients are
 * resolved straight from the RBAC tables.
 */
@Module({
  imports: [TypeOrmModule.forFeature([Notification, ActivityLog])],
  controllers: [NotificationController],
  providers: [NotificationService, NotificationListener],
})
export class NotificationModule {}
