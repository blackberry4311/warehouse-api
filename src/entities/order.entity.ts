import {
  Column,
  CreateDateColumn,
  Entity,
  JoinColumn,
  ManyToOne,
  OneToMany,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';
import { Organization } from './organization.entity';
import { User } from './user.entity';
import { OrderDetail } from './order-detail.entity';
import { numericTransformer } from './numeric.transformer';

/**
 * The lifecycle an order **header** moves through. Deliberately just three managed
 * states: the client places it IN_TRANSIT (goods en route), operations confirms it
 * into the warehouse (IN_WAREHOUSE — at which point its lines become inventory
 * items), and it can be CANCELLED from either live state. Per-line receipt is
 * tracked separately on {@link OrderDetail}.
 */
export enum OrderStatus {
  /** Placed by the client; goods are en route. The single initial state. */
  IN_TRANSIT = 'IN_TRANSIT',
  /** Operations confirmed the goods and stored them; the lines are now inventory. */
  IN_WAREHOUSE = 'IN_WAREHOUSE',
  CANCELLED = 'CANCELLED',
  /**
   * @deprecated Phase-2 removal. Not part of the order lifecycle any more — retained
   * on the enum (and the DB CHECK) only because the not-yet-refactored shipment
   * module still sets it when a shipment ships an order's full quantity. The order
   * module never transitions to COMPLETED.
   */
  COMPLETED = 'COMPLETED',
}

/** An order placed into the warehouse, scoped to a single organization. */
@Entity({ schema: 'wh', name: 'orders' })
export class Order {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  /** Human-readable number, unique within the org (e.g. ACME-000123). */
  @Column({ type: 'varchar', length: 255, name: 'order_number' })
  orderNumber: string;

  @Column({ type: 'uuid', name: 'org_id_fk' })
  orgId: string;

  /** The client user who placed the order. */
  @Column({ type: 'uuid', name: 'user_id_fk' })
  userId: string;

  /**
   * @deprecated Phase-2 removal. Shipment-only legacy: how much has been shipped
   * back out via locked shipments. The order's quantity now lives per-line on
   * {@link OrderDetail} — the header's scalar `qty` column has been dropped — so this
   * counter has nothing to count against until the shipment module is repointed at
   * the lines (phase 2), which will drop it too.
   */
  @Column({ type: 'numeric', name: 'shipped_qty', default: 0, transformer: numericTransformer })
  shippedQty: number;

  /**
   * Free-text tracking reference (typically a URL) the client supplies at
   * placement, pointing at the external carrier's system for the shipping /
   * arriving progress. Required — goods always move through an external shipper.
   */
  @Column({ type: 'text' })
  tracking: string;

  @Column({ type: 'varchar', length: 50, default: OrderStatus.IN_TRANSIT })
  status: OrderStatus;

  /**
   * Review gate. A reviewer (`review_order`) locks an order after placement:
   * while unlocked the client may still edit it; once locked the client is frozen
   * out and operations (`process_order`) can see and process it. Orthogonal to
   * `status` — an order stays IN_TRANSIT when locked until operations moves it into
   * the warehouse.
   */
  @Column({ type: 'boolean', default: false })
  locked: boolean;

  @ManyToOne(() => Organization, { onDelete: 'CASCADE', onUpdate: 'CASCADE' })
  @JoinColumn({ name: 'org_id_fk' })
  organization: Organization;

  @ManyToOne(() => User, { onUpdate: 'CASCADE' })
  @JoinColumn({ name: 'user_id_fk' })
  user: User;

  /** The order's line items — where the quantity now lives. */
  @OneToMany(() => OrderDetail, (detail) => detail.order)
  details: OrderDetail[];

  @CreateDateColumn({ type: 'timestamptz', name: 'created_at', precision: 3 })
  createdAt: Date;

  @UpdateDateColumn({ type: 'timestamptz', name: 'updated_at', nullable: true })
  updatedAt: Date;
}
