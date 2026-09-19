import {
  Column,
  CreateDateColumn,
  Entity,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
} from 'typeorm';
import { Shipment } from './shipment.entity';
import { User } from './user.entity';
import { FieldDiff } from './order-history.entity';

/**
 * The kind of change a `shipment_history` row records — the mirror of
 * {@link OrderChangeType}. Shipment-level and line-level changes are distinguished so
 * the FE can render a headline without parsing the `changes` payload.
 */
export enum ShipmentChangeType {
  /** Shipment placed — `changes` snapshots every line. */
  CREATED = 'CREATED',
  /** Header status moved. */
  STATUS_CHANGED = 'STATUS_CHANGED',
  /** A reviewer locked the shipment, handing it to operations. */
  LOCKED = 'LOCKED',
  /**
   * The client edited the line set while the shipment was still unlocked. A single
   * summary row per edit; `changes.items` carries every line that changed (added,
   * qty-updated, or removed).
   */
  ITEMS_CHANGED = 'ITEMS_CHANGED',
}

/**
 * The change to one shipment line — the order line item (`order_details`) it draws
 * from, snapshotted so a removed line still renders, plus a per-field `qty` diff
 * (to-only when added, from-only when removed, from+to when the qty changed).
 */
export interface ShipmentItemChange {
  /** The order line item this shipment line draws from (`order_details.id`). */
  orderDetailId: string;
  /** The referenced order line's name at the time — a snapshot. */
  name: string;
  /** The referenced line's order number at the time — a snapshot, for display. */
  orderNumber?: string;
  /** Per-field before/after (today just `qty`). */
  fields?: Record<string, FieldDiff>;
}

/**
 * The structured `changes` payload — the mirror of {@link OrderChange}. `shipment`
 * holds header-field diffs (`status`, `locked`); `items` snapshots every line at
 * placement (CREATED) or every line that changed in an edit (ITEMS_CHANGED).
 */
export interface ShipmentChange {
  shipment?: Record<string, FieldDiff>;
  items?: ShipmentItemChange[];
}

/**
 * Append-only audit trail for a shipment — the mirror of `order_history`. One row per
 * user action; the `change_type` categorizes it and the `changes` JSON carries the
 * before/after detail the FE shows.
 */
@Entity({ schema: 'wh', name: 'shipment_history' })
export class ShipmentHistory {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'uuid', name: 'shipment_id_fk' })
  shipmentId: string;

  /** The user who made the change. */
  @Column({ type: 'uuid', name: 'changed_by_fk' })
  changedBy: string;

  /** Relation to the changing user, layered on `changed_by_fk`. */
  @ManyToOne(() => User, { onUpdate: 'CASCADE' })
  @JoinColumn({ name: 'changed_by_fk' })
  changedByUser: User;

  @Column({ type: 'varchar', length: 50, name: 'change_type' })
  changeType: ShipmentChangeType;

  /** Structured before/after for this change; see {@link ShipmentChange}. */
  @Column({ type: 'jsonb', nullable: true })
  changes: ShipmentChange | null;

  @Column({ type: 'text', nullable: true })
  note: string | null;

  @ManyToOne(() => Shipment, { onDelete: 'CASCADE', onUpdate: 'CASCADE' })
  @JoinColumn({ name: 'shipment_id_fk' })
  shipment: Shipment;

  @CreateDateColumn({ type: 'timestamptz', name: 'created_at', precision: 3 })
  createdAt: Date;
}
