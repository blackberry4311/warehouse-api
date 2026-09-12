import {
  Column,
  CreateDateColumn,
  Entity,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
} from 'typeorm';
import { Order, OrderStatus } from './order.entity';
import { User } from './user.entity';
import { numericTransformer } from './numeric.transformer';

export enum OrderChangeType {
  CREATED = 'CREATED',
  STATUS_CHANGE = 'STATUS_CHANGE',
  QTY_CHANGE = 'QTY_CHANGE',
  /** A reviewer (`review_order`) locked the order, handing it to operations. */
  LOCKED = 'LOCKED',
}

/**
 * Append-only audit trail for an order. One row per change; a CREATED row is
 * written when the order is first placed. The prev/new columns hold only what changed.
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

  @Column({ type: 'varchar', length: 50, name: 'prev_status', nullable: true })
  prevStatus: OrderStatus | null;

  @Column({ type: 'varchar', length: 50, name: 'new_status', nullable: true })
  newStatus: OrderStatus | null;

  @Column({ type: 'numeric', name: 'prev_qty', nullable: true, transformer: numericTransformer })
  prevQty: number | null;

  @Column({ type: 'numeric', name: 'new_qty', nullable: true, transformer: numericTransformer })
  newQty: number | null;

  @Column({ type: 'text', nullable: true })
  note: string | null;

  @ManyToOne(() => Order, { onDelete: 'CASCADE', onUpdate: 'CASCADE' })
  @JoinColumn({ name: 'order_id_fk' })
  order: Order;

  @CreateDateColumn({ type: 'timestamptz', name: 'created_at', precision: 3 })
  createdAt: Date;
}
