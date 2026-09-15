import {
  Column,
  CreateDateColumn,
  Entity,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
} from 'typeorm';
import { Organization } from './organization.entity';
import { Order } from './order.entity';
import { Shipment } from './shipment.entity';
import { User } from './user.entity';
import { numericTransformer } from './numeric.transformer';

/**
 * Every fee charged against a single order **or** a single shipment, of two kinds
 * distinguished by `is_protected`:
 *
 *  - the **lock fee** (`is_protected = true`) — written automatically when the
 *    order/shipment is locked, for the org's flat `ORDER_LOCK` / `SHIPMENT_LOCK`
 *    amount. Exactly one per target, and it **cannot be voided** (it is the system
 *    charge, not a staff line).
 *  - an ad-hoc **extra fee** (`is_protected = false`) — a free-form line
 *    (`name` + `amount`) operations staff add while the target is being processed.
 *    These **can** be voided by staff with the right permission.
 *
 * Saving any fee charges the *client* who placed the order/shipment straight away
 * and writes a matching `credit_history` row (linked back via `fee_id_fk`).
 *
 * Order vs shipment is carried the same way `credit_history` carries it: exactly
 * one of `order_id_fk` / `shipment_id_fk` is set (enforced by a CHECK), so one
 * table serves both flows.
 *
 * The row is immutable once created; a mistaken (non-protected) fee is **voided**
 * (not deleted or edited) — `voided_at`/`voided_by_fk` are stamped and a reversing
 * `EXTRA_FEE` ledger row (positive amount) refunds the client, so the ledger stays
 * append-only and per-org earnings net out automatically.
 */
@Entity({ schema: 'wh', name: 'total_fees' })
export class TotalFee {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  /** Free-text fee name shown to the client (e.g. "Order lock fee", "Repackaging"). */
  @Column({ type: 'varchar', length: 200 })
  name: string;

  /** The (non-negative) amount charged against the client's credit. */
  @Column({ type: 'numeric', transformer: numericTransformer })
  amount: number;

  /**
   * True for the system lock fee (non-voidable), false for a staff-added extra fee
   * (voidable). Drives whether {@link voidFee} will act on the row.
   */
  @Column({ type: 'boolean', name: 'is_protected', default: false })
  isProtected: boolean;

  /** The org the fee belongs to — for per-org earnings, like `credit_history`. */
  @Column({ type: 'uuid', name: 'org_id_fk' })
  orgId: string;

  /** The order this fee is attached to (null when it is a shipment fee). */
  @Column({ type: 'uuid', name: 'order_id_fk', nullable: true })
  orderId: string | null;

  /** The shipment this fee is attached to (null when it is an order fee). */
  @Column({ type: 'uuid', name: 'shipment_id_fk', nullable: true })
  shipmentId: string | null;

  /** The user who created (and thereby charged) the fee — the reviewer, for a lock fee. */
  @Column({ type: 'uuid', name: 'created_by_fk' })
  createdBy: string;

  @Column({ type: 'text', nullable: true })
  note: string | null;

  /** When the fee was voided (refunded), if it has been; null while active. */
  @Column({ type: 'timestamptz', name: 'voided_at', precision: 3, nullable: true })
  voidedAt: Date | null;

  /** The staffer who voided the fee, if any. */
  @Column({ type: 'uuid', name: 'voided_by_fk', nullable: true })
  voidedBy: string | null;

  @ManyToOne(() => Organization, { onDelete: 'CASCADE', onUpdate: 'CASCADE' })
  @JoinColumn({ name: 'org_id_fk' })
  organization: Organization;

  @ManyToOne(() => Order, { onDelete: 'CASCADE', onUpdate: 'CASCADE' })
  @JoinColumn({ name: 'order_id_fk' })
  order: Order | null;

  @ManyToOne(() => Shipment, { onDelete: 'CASCADE', onUpdate: 'CASCADE' })
  @JoinColumn({ name: 'shipment_id_fk' })
  shipment: Shipment | null;

  /** Relation to the creating user, layered on `created_by_fk` (safe columns only). */
  @ManyToOne(() => User, { onUpdate: 'CASCADE' })
  @JoinColumn({ name: 'created_by_fk' })
  createdByUser: User;

  /** Relation to the voiding user, layered on `voided_by_fk`. */
  @ManyToOne(() => User, { onUpdate: 'CASCADE' })
  @JoinColumn({ name: 'voided_by_fk' })
  voidedByUser: User | null;

  @CreateDateColumn({ type: 'timestamptz', name: 'created_at', precision: 3 })
  createdAt: Date;
}
