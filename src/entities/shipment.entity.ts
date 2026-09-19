import {
  Column,
  CreateDateColumn,
  Entity,
  JoinColumn,
  ManyToOne,
  OneToMany,
  OneToOne,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';
import { Organization } from './organization.entity';
import { User } from './user.entity';
import { ShipmentDetail } from './shipment-detail.entity';
import { ShipmentLabel } from './shipment-label.entity';

/**
 * The lifecycle a shipment (an outbound withdrawal of stored goods) moves through.
 * Deliberately shorter than an order's: a client places an AWAITING shipment, a
 * reviewer locks it (the billing + stock-deduction handoff, orthogonal to `status`),
 * then operations marks it DONE or CANCELLED. Locking does not change `status`.
 */
export enum ShipmentStatus {
  /** Placed by the client; awaiting review/lock, then dispatch. The initial state. */
  AWAITING = 'AWAITING',
  /** Goods handed to the outbound carrier / fulfilled. Terminal. */
  DONE = 'DONE',
  CANCELLED = 'CANCELLED',
}

/**
 * A shipment: a client's request to ship some quantity out of one or more of their
 * warehoused order line items (inventory). The per-line quantities live on the
 * `shipment_details` junction (`items`) — one shipment can draw from several lines at
 * once (e.g. 10 from one line and 20 from another).
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

  @Column({ type: 'varchar', length: 50, default: ShipmentStatus.AWAITING })
  status: ShipmentStatus;

  /**
   * Review gate, identical in spirit to `Order.locked`: a reviewer
   * (`review_shipment`) locks the shipment after placement. Locking freezes the
   * client out, charges the client's `SHIPMENT_LOCK` fee, deducts each line's qty
   * from the order line item it draws from (`order_details.shipped_qty`), and
   * surfaces the shipment into the operations (`process_shipment`) queue.
   */
  @Column({ type: 'boolean', default: false })
  locked: boolean;

  @ManyToOne(() => Organization, { onDelete: 'CASCADE', onUpdate: 'CASCADE' })
  @JoinColumn({ name: 'org_id_fk' })
  organization: Organization;

  @ManyToOne(() => User, { onUpdate: 'CASCADE' })
  @JoinColumn({ name: 'user_id_fk' })
  user: User;

  /** Per-line shipped quantities. Cascade-deletes with the shipment. */
  @OneToMany(() => ShipmentDetail, (item) => item.shipment)
  items: ShipmentDetail[];

  /**
   * The shipping-label image (inverse side; the FK lives on `shipment_labels`). One
   * per shipment — the client attaches the label the warehouse prints. Never selected
   * by default; the reads expose only a `hasLabel` flag, never the storage key.
   */
  @OneToOne(() => ShipmentLabel, (label) => label.shipment)
  label?: ShipmentLabel;

  /**
   * Non-persisted, list-only summary of `items`: how many orders this shipment
   * draws from and their combined qty. Populated by `listShipments` (which does
   * not load the full line set) so the UI can show them without a per-row fetch;
   * `undefined` on single-shipment reads, which carry the full `items` instead.
   */
  inventoryItemCount?: number;
  totalQty?: number;

  /** Non-persisted: whether a label image is attached (set by the reads). */
  hasLabel?: boolean;

  @CreateDateColumn({ type: 'timestamptz', name: 'created_at', precision: 3 })
  createdAt: Date;

  @UpdateDateColumn({ type: 'timestamptz', name: 'updated_at', nullable: true })
  updatedAt: Date;
}
