import {
  Column,
  CreateDateColumn,
  Entity,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';
import { Organization } from './organization.entity';
import { User } from './user.entity';
import { numericTransformer } from './numeric.transformer';

/** The lifecycle a warehouse order moves through. */
export enum OrderStatus {
  /** Placed by the client; goods are en route by cargo ship. Client-reported. */
  SHIPPING = 'SHIPPING',
  /** Cargo has docked and is on its way to the warehouse. Client-reported. */
  ARRIVING = 'ARRIVING',
  /** Operation confirmed the goods and stored them. From here the client can
   * request a shipment (that flow is future work). */
  IN_WAREHOUSE = 'IN_WAREHOUSE',
  /** Fully withdrawn / closed. */
  COMPLETED = 'COMPLETED',
  CANCELLED = 'CANCELLED',
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

  @Column({ type: 'numeric', transformer: numericTransformer })
  qty: number;

  /**
   * Free-text tracking reference (typically a URL) the client supplies at
   * placement, pointing at the external carrier's system for the shipping /
   * arriving progress. Required — goods always move through an external shipper.
   */
  @Column({ type: 'text' })
  tracking: string;

  @Column({ type: 'varchar', length: 50, default: OrderStatus.SHIPPING })
  status: OrderStatus;

  /**
   * Review gate. A reviewer (`review_order`) locks an order after placement:
   * while unlocked the client may still edit it; once locked the client is frozen
   * out and operations (`manage_order`) can see and process it. Orthogonal to
   * `status` — an order stays in its pending state (SHIPPING/ARRIVING) when locked
   * until operations moves it into the warehouse.
   */
  @Column({ type: 'boolean', default: false })
  locked: boolean;

  @ManyToOne(() => Organization, { onDelete: 'CASCADE', onUpdate: 'CASCADE' })
  @JoinColumn({ name: 'org_id_fk' })
  organization: Organization;

  @ManyToOne(() => User, { onUpdate: 'CASCADE' })
  @JoinColumn({ name: 'user_id_fk' })
  user: User;

  @CreateDateColumn({ type: 'timestamptz', name: 'created_at', precision: 3 })
  createdAt: Date;

  @UpdateDateColumn({ type: 'timestamptz', name: 'updated_at', nullable: true })
  updatedAt: Date;
}
