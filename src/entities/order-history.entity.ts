import {
  Column,
  CreateDateColumn,
  Entity,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
} from 'typeorm';
import { Order } from './order.entity';
import { User } from './user.entity';

/**
 * The kind of change an `order_history` row records. Order-level and line-level
 * changes are distinguished so the FE can render a headline without parsing the
 * `changes` payload.
 */
export enum OrderChangeType {
  /** Order placed — `changes` snapshots the header and every line. */
  CREATED = 'CREATED',
  /** Header field(s) edited (e.g. `tracking`). */
  ORDER_UPDATED = 'ORDER_UPDATED',
  /** Header status moved. */
  STATUS_CHANGED = 'STATUS_CHANGED',
  /** A reviewer locked the order, handing it to operations. */
  LOCKED = 'LOCKED',
  /** A line was added. */
  ITEM_ADDED = 'ITEM_ADDED',
  /** A line's name/qty/note was edited. */
  ITEM_UPDATED = 'ITEM_UPDATED',
  /** A line was removed. */
  ITEM_REMOVED = 'ITEM_REMOVED',
  /** Operations set a line's receipt status (PENDING → RECEIVED / …). */
  ITEM_RECEIPT = 'ITEM_RECEIPT',
}

/**
 * A single field's before/after. `from` is omitted when a value is first set (an
 * add / CREATED), `to` is omitted when it is cleared (a remove). Values are whatever
 * the field holds — string, number, or null.
 */
export interface FieldDiff {
  from?: string | number | boolean | null;
  to?: string | number | boolean | null;
}

/** The change to one line item, with a display-name snapshot and per-field diffs. */
export interface OrderItemChange {
  /** The line's id (its `order_details.id`). */
  detailId: string;
  /** The line's name at the time — a snapshot, so a removed line still renders. */
  name: string;
  /** Per-field before/after (e.g. `qty`, `name`, `note`, `status`). */
  fields?: Record<string, FieldDiff>;
}

/**
 * The structured `changes` payload. `order` holds header-field diffs; `item` holds a
 * single line's change (the granular /details endpoints touch one line at a time);
 * `items` is used only by CREATED to snapshot every line at placement.
 */
export interface OrderChange {
  order?: Record<string, FieldDiff>;
  item?: OrderItemChange;
  items?: OrderItemChange[];
}

/**
 * Append-only audit trail for an order. One row per user action; the `change_type`
 * categorizes it and the `changes` JSON carries the before/after detail the FE shows
 * the client.
 */
@Entity({ schema: 'wh', name: 'order_history' })
export class OrderHistory {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'uuid', name: 'order_id_fk' })
  orderId: string;

  /** The user who made the change. */
  @Column({ type: 'uuid', name: 'changed_by_fk' })
  changedBy: string;

  /** Relation to the changing user, layered on `changed_by_fk` (see `changedBy`). */
  @ManyToOne(() => User, { onUpdate: 'CASCADE' })
  @JoinColumn({ name: 'changed_by_fk' })
  changedByUser: User;

  @Column({ type: 'varchar', length: 50, name: 'change_type' })
  changeType: OrderChangeType;

  /** Structured before/after for this change; see {@link OrderChange}. */
  @Column({ type: 'jsonb', nullable: true })
  changes: OrderChange | null;

  @Column({ type: 'text', nullable: true })
  note: string | null;

  @ManyToOne(() => Order, { onDelete: 'CASCADE', onUpdate: 'CASCADE' })
  @JoinColumn({ name: 'order_id_fk' })
  order: Order;

  @CreateDateColumn({ type: 'timestamptz', name: 'created_at', precision: 3 })
  createdAt: Date;
}
