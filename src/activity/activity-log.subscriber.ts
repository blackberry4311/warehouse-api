import { Injectable, Logger } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { InjectDataSource } from '@nestjs/typeorm';
import {
  DataSource,
  EntitySubscriberInterface,
  InsertEvent,
  QueryRunner,
  TransactionCommitEvent,
  TransactionRollbackEvent,
} from 'typeorm';
import { ActivityLog } from '../entities/activity-log.entity';
import { ACTIVITY_RECORDED, ActivityRecordedEvent } from './activity.events';

/** Key on `QueryRunner.data` under which a transaction's new activity rows collect. */
const PENDING_KEY = 'pendingActivities';

/**
 * Turns `activity_log` inserts into an `activity.recorded` event **after commit**, in
 * one place — so the order / shipment / fee / credit code needs no emit calls, and a
 * rolled-back action never notifies anyone. Rows inserted in a transaction are
 * buffered on its `QueryRunner` and emitted together once the outermost transaction
 * commits (savepoint releases also fire the commit hook, so those are ignored).
 */
@Injectable()
export class ActivityLogSubscriber implements EntitySubscriberInterface<ActivityLog> {
  private readonly logger = new Logger(ActivityLogSubscriber.name);

  constructor(
    @InjectDataSource() dataSource: DataSource,
    private readonly events: EventEmitter2,
  ) {
    dataSource.subscribers.push(this);
  }

  listenTo() {
    return ActivityLog;
  }

  afterInsert(event: InsertEvent<ActivityLog>): void {
    const pending = this.pending(event.queryRunner);
    pending.push(event.entity);
  }

  afterTransactionCommit(event: TransactionCommitEvent): void {
    const qr = event.queryRunner;
    if (qr.isTransactionActive) return; // a savepoint release, not the real commit
    const activities = this.take(qr);
    if (activities.length === 0) return;

    const payload: ActivityRecordedEvent = { activities };
    // emitAsync so a failing listener can't throw back into the committed request;
    // the notification sweep retries whatever it misses.
    this.events.emitAsync(ACTIVITY_RECORDED, payload).catch((err: unknown) => {
      this.logger.error(`${ACTIVITY_RECORDED} listener failed`, err as Error);
    });
  }

  afterTransactionRollback(event: TransactionRollbackEvent): void {
    if (!event.queryRunner.isTransactionActive) this.take(event.queryRunner);
  }

  private pending(qr: QueryRunner): ActivityLog[] {
    const data = qr.data as Record<string, ActivityLog[] | undefined>;
    return (data[PENDING_KEY] ??= []);
  }

  /** Remove and return the buffered rows. */
  private take(qr: QueryRunner): ActivityLog[] {
    const data = qr.data as Record<string, ActivityLog[] | undefined>;
    const rows = data[PENDING_KEY] ?? [];
    delete data[PENDING_KEY];
    return rows;
  }
}
