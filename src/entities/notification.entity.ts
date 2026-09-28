import {
  Column,
  CreateDateColumn,
  Entity,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
} from 'typeorm';
import { ActivityLog } from './activity-log.entity';
import { User } from './user.entity';

/**
 * An in-app notification: one `activity_log` row delivered to one recipient. The
 * content lives on the activity (action, summary, actor); this row only tracks who
 * it is for and whether they've read it. Unique per `(recipient, activity)`, so the
 * fan-out (event listener + sweep) is idempotent.
 */
@Entity({ schema: 'wh', name: 'notifications' })
export class Notification {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'uuid', name: 'recipient_id_fk' })
  recipientId: string;

  @Column({ type: 'uuid', name: 'activity_id_fk' })
  activityId: string;

  @Column({ type: 'timestamptz', name: 'read_at', precision: 3, nullable: true })
  readAt: Date | null;

  @ManyToOne(() => User, { onDelete: 'CASCADE', onUpdate: 'CASCADE' })
  @JoinColumn({ name: 'recipient_id_fk' })
  recipient: User;

  @ManyToOne(() => ActivityLog, { onDelete: 'CASCADE', onUpdate: 'CASCADE' })
  @JoinColumn({ name: 'activity_id_fk' })
  activity: ActivityLog;

  @CreateDateColumn({ type: 'timestamptz', name: 'created_at', precision: 3 })
  createdAt: Date;
}
