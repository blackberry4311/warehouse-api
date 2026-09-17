import {
  Column,
  CreateDateColumn,
  Entity,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
} from 'typeorm';
import { Order } from './order.entity';
import { numericTransformer } from './numeric.transformer';

/**
 * The receipt / inventory lifecycle of a single order line. A line is declared by
 * the client as PENDING; once the order is locked, operations confirms each line as
 * RECEIVED (it becomes a warehouse inventory item) or NOT_ARRIVED (the client
 * declared it but it never showed up), or CANCELLED. There is deliberately no
 * COMPLETED here in phase 1 — drawing stock back out (which will retire a line) is
 * the shipment refactor's job, left for phase 2.
 */
export enum OrderDetailStatus {
  /** Declared by the client at placement; not yet confirmed at the warehouse. */
  PENDING = 'PENDING',
  /** Operations confirmed the goods arrived and stored them — now inventory. */
  RECEIVED = 'RECEIVED',
  /** The client declared this line but it never reached the warehouse. */
  NOT_ARRIVED = 'NOT_ARRIVED',
  /** The line was cancelled. */
  CANCELLED = 'CANCELLED',
}

/**
 * One line item on an order. Each order is a header carrying one or more of these —
 * the line, not the order, holds the quantity (the order's old scalar `qty` is gone
 * from the API). `name` is the client's per-line free text, slugified and joined to
 * their client code with a hyphen (e.g. code `ACME` + `"blue widgets"` →
 * `ACME-blue-widgets`). A RECEIVED line is a warehouse inventory unit.
 */
@Entity({ schema: 'wh', name: 'order_details' })
export class OrderDetail {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'uuid', name: 'order_id_fk' })
  orderId: string;

  /** Client code + the free text the client typed for this line. */
  @Column({ type: 'varchar', length: 255 })
  name: string;

  @Column({ type: 'numeric', transformer: numericTransformer })
  qty: number;

  @Column({ type: 'text', nullable: true })
  note: string | null;

  @Column({ type: 'varchar', length: 50, default: OrderDetailStatus.PENDING })
  status: OrderDetailStatus;

  @ManyToOne(() => Order, (order) => order.details, {
    onDelete: 'CASCADE',
    onUpdate: 'CASCADE',
  })
  @JoinColumn({ name: 'order_id_fk' })
  order: Order;

  @CreateDateColumn({ type: 'timestamptz', name: 'created_at', precision: 3 })
  createdAt: Date;
}
