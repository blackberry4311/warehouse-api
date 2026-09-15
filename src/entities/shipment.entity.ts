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
import { ShipmentDetail } from './shipment-detail.entity';

/**
 * The lifecycle a shipment (an outbound withdrawal of stored goods) moves through.
 * Deliberately shorter than an order's: a client places a REQUESTED shipment, a
 * reviewer locks it (the billing + stock-deduction handoff, orthogonal to `status`),
 * then operations marks it DELIVERED or CANCELLED. Locking does not change `status`.
 */
export enum ShipmentStatus {
  /** Placed by the client; awaiting review/lock, then dispatch. */
  REQUESTED = 'REQUESTED',
  /** Goods handed to the outbound carrier and delivered. Terminal. */
  DELIVERED = 'DELIVERED',
  CANCELLED = 'CANCELLED',
}

/**
 * A shipment: a client's request to ship some quantity out of one or more of their
 * warehoused orders. The per-order quantities live on the `shipment_details`
 * junction (`items`) — one shipment can draw from several orders at once (e.g. 10
 * from one order and 20 from another).
 */
@Entity({ schema: 'wh', name: 'shipments' })
export class Shipment {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  /** Human-readable number, unique within the org (e.g. ACME-S000123). */
  @Column({ type: 'varchar', length: 255, name: 'shipment_number' })
  shipmentNumber: string;

  @Column({ type: 'uuid', name: 'org_id_fk' })
  orgId: string;

  /** The client user who requested the shipment. */
  @Column({ type: 'uuid', name: 'user_id_fk' })
  userId: string;

  @Column({ type: 'varchar', length: 50, default: ShipmentStatus.REQUESTED })
  status: ShipmentStatus;

  /**
   * Review gate, identical in spirit to `Order.locked`: a reviewer
   * (`review_shipment`) locks the shipment after placement. Locking freezes the
   * client out, charges the client's `SHIPMENT_LOCK` fee, deducts each line's
   * qty from its order (completing fully-shipped orders), and surfaces the shipment
   * into the operations (`process_shipment`) queue.
   */
  @Column({ type: 'boolean', default: false })
  locked: boolean;

  /**
   * Optional free-text tracking reference (typically a carrier URL) for the
   * outbound leg. Unlike an order's inbound tracking this is optional — operations
   * often assign it only once the goods are dispatched.
   */
  @Column({ type: 'text', nullable: true })
  tracking: string | null;

  @ManyToOne(() => Organization, { onDelete: 'CASCADE', onUpdate: 'CASCADE' })
  @JoinColumn({ name: 'org_id_fk' })
  organization: Organization;

  @ManyToOne(() => User, { onUpdate: 'CASCADE' })
  @JoinColumn({ name: 'user_id_fk' })
  user: User;

  /** Per-order shipped quantities. Cascade-deletes with the shipment. */
  @OneToMany(() => ShipmentDetail, (item) => item.shipment)
  items: ShipmentDetail[];

  /**
   * Non-persisted, list-only summary of `items`: how many orders this shipment
   * draws from and their combined qty. Populated by `listShipments` (which does
   * not load the full line set) so the UI can show them without a per-row fetch;
   * `undefined` on single-shipment reads, which carry the full `items` instead.
   */
  orderCount?: number;
  totalQty?: number;

  @CreateDateColumn({ type: 'timestamptz', name: 'created_at', precision: 3 })
  createdAt: Date;

  @UpdateDateColumn({ type: 'timestamptz', name: 'updated_at', nullable: true })
  updatedAt: Date;
}
