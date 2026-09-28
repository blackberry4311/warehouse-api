import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ActivityController } from './activity.controller';
import { ActivityService } from './activity.service';
import { ActivityLogSubscriber } from './activity-log.subscriber';
import { ActivityLog } from '../entities/activity-log.entity';
import { OrganizationModule } from '../organization/organization.module';

/**
 * Read side of the activity feed (`activity_log`). Standalone, like InventoryModule:
 * it reuses `OrganizationService` for org existence, membership and the per-org
 * permission check. Rows are written elsewhere, via `recordActivity`; its
 * `ActivityLogSubscriber` emits `activity.recorded` once they commit.
 */
@Module({
  imports: [TypeOrmModule.forFeature([ActivityLog]), OrganizationModule],
  controllers: [ActivityController],
  providers: [ActivityService, ActivityLogSubscriber],
})
export class ActivityModule {}
