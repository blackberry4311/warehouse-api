import { Injectable, Logger } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { Cron, CronExpression } from '@nestjs/schedule';
import { ACTIVITY_RECORDED, ActivityRecordedEvent } from '../activity/activity.events';
import { NotificationService } from './notification.service';

/**
 * Drives the fan-out: immediately on `activity.recorded` (emitted after commit), and
 * every minute as a sweep for anything the event path missed. Both are idempotent —
 * `NotificationService` claims each activity row before delivering it.
 */
@Injectable()
export class NotificationListener {
  private readonly logger = new Logger(NotificationListener.name);

  constructor(private readonly notificationService: NotificationService) {}

  @OnEvent(ACTIVITY_RECORDED, { async: true })
  async handleActivityRecorded(event: ActivityRecordedEvent): Promise<void> {
    try {
      await this.notificationService.notifyActivities(event.activities.map((a) => a.id));
    } catch (err) {
      // Left un-notified; the sweep retries it.
      this.logger.error(`Notification fan-out failed: ${(err as Error).message}`);
    }
  }

  @Cron(CronExpression.EVERY_MINUTE)
  async sweep(): Promise<void> {
    try {
      const count = await this.notificationService.sweepPending();
      if (count > 0) this.logger.log(`Swept ${count} un-notified activity row(s)`);
    } catch (err) {
      this.logger.error(`Notification sweep failed: ${(err as Error).message}`);
    }
  }
}
