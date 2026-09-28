import {
  Column,
  CreateDateColumn,
  Entity,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
} from 'typeorm';
import { Organization } from './organization.entity';
import { User } from './user.entity';

/** What kind of record an activity is about — `entity_id` points into that table. */
export enum ActivityEntityType {
  ORDER = 'ORDER',
  SHIPMENT = 'SHIPMENT',
  /** A standalone `credit_history` entry (top-up / adjustment / reseller commission).
   * Charges tied to an order/shipment (lock fee, extra fees) are logged against that
   * ORDER / SHIPMENT instead, with the amount in the summary. */
  CREDIT = 'CREDIT',
}

/**
 * The headline of an activity row. Unlike `order_history.change_type`, this is not
 * `CHECK`-constrained in the DB, so new actions can be added without a migration.
 */
export enum ActivityAction {
  ORDER_PLACED = 'ORDER_PLACED',
  ORDER_UPDATED = 'ORDER_UPDATED',
  ORDER_STATUS_CHANGED = 'ORDER_STATUS_CHANGED',
  ORDER_LOCKED = 'ORDER_LOCKED',
  ORDER_ITEM_ADDED = 'ORDER_ITEM_ADDED',
  ORDER_ITEM_UPDATED = 'ORDER_ITEM_UPDATED',
  ORDER_ITEM_REMOVED = 'ORDER_ITEM_REMOVED',
  ORDER_ITEM_RECEIPT = 'ORDER_ITEM_RECEIPT',
  /** Staff added an extra fee to the order (charges the client). */
  ORDER_FEE_ADDED = 'ORDER_FEE_ADDED',
  /** Staff voided an extra fee on the order (refunds the client). */
  ORDER_FEE_VOIDED = 'ORDER_FEE_VOIDED',
  SHIPMENT_PLACED = 'SHIPMENT_PLACED',
  SHIPMENT_ITEMS_CHANGED = 'SHIPMENT_ITEMS_CHANGED',
  SHIPMENT_LOCKED = 'SHIPMENT_LOCKED',
  SHIPMENT_STATUS_CHANGED = 'SHIPMENT_STATUS_CHANGED',
  SHIPMENT_FEE_ADDED = 'SHIPMENT_FEE_ADDED',
  SHIPMENT_FEE_VOIDED = 'SHIPMENT_FEE_VOIDED',
  /** The client attached or replaced the shipping label. */
  SHIPMENT_LABEL_SET = 'SHIPMENT_LABEL_SET',
  SHIPMENT_LABEL_REMOVED = 'SHIPMENT_LABEL_REMOVED',
  CREDIT_TOPPED_UP = 'CREDIT_TOPPED_UP',
  CREDIT_ADJUSTED = 'CREDIT_ADJUSTED',
  /** A credit-group owner was credited their markup on a member's order/shipment lock. */
  CREDIT_COMMISSION = 'CREDIT_COMMISSION',
}

/** Small, display-ready payload (e.g. order number, amount) so the feed renders
 * without joining back to the source row. Detailed diffs stay in the per-entity
 * history tables. */
export type ActivitySummary = Record<string, unknown>;

/**
 * System-wide, append-only activity feed: one row per user action across orders,
 * shipments and credit. Written in the **same transaction** as the change (via
 * `recordActivity`), so an action can't commit without its activity row. It sits
 * alongside — not instead of — `order_history` / `shipment_history` / `credit_history`,
 * which keep the detailed per-entity trail.
 */
@Entity({ schema: 'wh', name: 'activity_log' })
export class ActivityLog {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  /** The org the action happened in (null for a future system-level action). */
  @Column({ type: 'uuid', name: 'org_id_fk', nullable: true })
  orgId: string | null;

  /** The user who performed the action (null for system/cron actions). */
  @Column({ type: 'uuid', name: 'actor_id_fk', nullable: true })
  actorId: string | null;

  /** The user the action is *about*, when different from the record — e.g. the
   * client who owns the order, or the member whose credit was topped up. */
  @Column({ type: 'uuid', name: 'subject_user_id_fk', nullable: true })
  subjectUserId: string | null;

  @Column({ type: 'varchar', length: 30, name: 'entity_type' })
  entityType: ActivityEntityType;

  /** The id of the affected record in the table named by `entityType` (no FK — polymorphic). */
  @Column({ type: 'uuid', name: 'entity_id' })
  entityId: string;

  @Column({ type: 'varchar', length: 50 })
  action: ActivityAction;

  @Column({ type: 'jsonb', nullable: true })
  summary: ActivitySummary | null;

  /** When this row was fanned out into `notifications` (null = still pending; the
   * notification sweep picks those up). */
  @Column({ type: 'timestamptz', name: 'notified_at', precision: 3, nullable: true })
  notifiedAt: Date | null;

  @ManyToOne(() => Organization, { onDelete: 'CASCADE', onUpdate: 'CASCADE' })
  @JoinColumn({ name: 'org_id_fk' })
  organization: Organization | null;

  @ManyToOne(() => User, { onDelete: 'SET NULL', onUpdate: 'CASCADE' })
  @JoinColumn({ name: 'actor_id_fk' })
  actor: User | null;

  @ManyToOne(() => User, { onDelete: 'SET NULL', onUpdate: 'CASCADE' })
  @JoinColumn({ name: 'subject_user_id_fk' })
  subjectUser: User | null;

  @CreateDateColumn({ type: 'timestamptz', name: 'created_at', precision: 3 })
  createdAt: Date;
}
