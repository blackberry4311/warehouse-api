import {
  Column,
  CreateDateColumn,
  Entity,
  JoinColumn,
  ManyToOne,
  OneToOne,
  PrimaryGeneratedColumn,
} from 'typeorm';
import { Organization } from './organization.entity';
import { Order } from './order.entity';
import { Shipment } from './shipment.entity';
import { TotalFee } from './total-fee.entity';
import { User } from './user.entity';
import { CreditResource } from './credit-resource.entity';
import { numericTransformer } from './numeric.transformer';

/**
 * Why a user's credit changed. The charge types (`ORDER_LOCK`, `SHIPMENT_LOCK`,
 * `EXTRA_FEE`) mirror `FeeType` and are what warehouse earnings sum over, together
 * with `RESELLER_COMMISSION` (a credit-group owner's markup, which nets a marked-up
 * charge back down to the org base); `TOP_UP` and `ADJUSTMENT` cover the client
 * adding funds and manual corrections.
 */
export enum CreditEntryType {
  /** Charged when a reviewer locks the client's order. */
  ORDER_LOCK = 'ORDER_LOCK',
  /** Charged when a reviewer locks the client's shipment. */
  SHIPMENT_LOCK = 'SHIPMENT_LOCK',
  /**
   * A `total_fees` line staff added against an order/shipment: negative on the
   * charge, positive on a void (the reversal), so the EXTRA_FEE sum nets out.
   * Linked back to the fee via `fee_id_fk`. (The flat lock fee also has a
   * `total_fees` row but is booked under `ORDER_LOCK`/`SHIPMENT_LOCK`.)
   */
  EXTRA_FEE = 'EXTRA_FEE',
  /** The client added funds. */
  TOP_UP = 'TOP_UP',
  /** Manual correction. */
  ADJUSTMENT = 'ADJUSTMENT',
  /**
   * The markup a credit group's **owner** earns when a member's order/shipment is
   * locked: a positive credit (`group fee − org fee`) into the owner's wallet,
   * linked to the triggering order/shipment and lock fee. Because it is positive
   * and counted in the warehouse-earnings sum, it self-nets the client's charge
   * back down to the org base — see the earnings note below.
   */
  RESELLER_COMMISSION = 'RESELLER_COMMISSION',
}

/**
 * Append-only ledger of every change to a user's credit. `amount` is the signed
 * delta (negative = charge, positive = top-up/refund) so `newBalance = prevBalance
 * + amount` always holds; `order` links a charge to the order that triggered it.
 * Warehouse earnings for an org over a period = `-SUM(amount)` over the charge
 * entry types, which **include** `RESELLER_COMMISSION`: since a commission is a
 * positive credit to a credit-group owner, subtracting it nets the client's marked-up
 * charge back down to the org base the warehouse actually keeps. A reviewer's own
 * earnings = `SUM(amount)` over their `RESELLER_COMMISSION` rows.
 */
@Entity({ schema: 'wh', name: 'credit_history' })
export class CreditHistory {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  /** The user whose credit changed (for an order lock, the client who placed it). */
  @Column({ type: 'uuid', name: 'user_id_fk' })
  userId: string;

  /** The org context the charge belongs to — used for per-org earnings reporting. */
  @Column({ type: 'uuid', name: 'org_id_fk' })
  orgId: string;

  @Column({ type: 'varchar', length: 50, name: 'entry_type' })
  entryType: CreditEntryType;

  /** Signed delta applied to the balance: negative for a charge, positive to add. */
  @Column({ type: 'numeric', transformer: numericTransformer })
  amount: number;

  @Column({ type: 'numeric', name: 'prev_balance', transformer: numericTransformer })
  prevBalance: number;

  @Column({ type: 'numeric', name: 'new_balance', transformer: numericTransformer })
  newBalance: number;

  /** The order that triggered the charge, if any (null for top-ups/adjustments). */
  @Column({ type: 'uuid', name: 'order_id_fk', nullable: true })
  orderId: string | null;

  /** The shipment that triggered the charge, if any (a SHIPMENT_LOCK fee). */
  @Column({ type: 'uuid', name: 'shipment_id_fk', nullable: true })
  shipmentId: string | null;

  /** The total_fees row that triggered the movement, if any (a lock or extra-fee charge/void). */
  @Column({ type: 'uuid', name: 'fee_id_fk', nullable: true })
  feeId: string | null;

  @Column({ type: 'text', nullable: true })
  note: string | null;

  @ManyToOne(() => User, { onDelete: 'CASCADE', onUpdate: 'CASCADE' })
  @JoinColumn({ name: 'user_id_fk' })
  user: User;

  @ManyToOne(() => Organization, { onDelete: 'CASCADE', onUpdate: 'CASCADE' })
  @JoinColumn({ name: 'org_id_fk' })
  organization: Organization;

  @ManyToOne(() => Order, { onDelete: 'SET NULL', onUpdate: 'CASCADE' })
  @JoinColumn({ name: 'order_id_fk' })
  order: Order | null;

  @ManyToOne(() => Shipment, { onDelete: 'SET NULL', onUpdate: 'CASCADE' })
  @JoinColumn({ name: 'shipment_id_fk' })
  shipment: Shipment | null;

  @ManyToOne(() => TotalFee, { onDelete: 'SET NULL', onUpdate: 'CASCADE' })
  @JoinColumn({ name: 'fee_id_fk' })
  fee: TotalFee | null;

  /**
   * An attached file resource (a `TOP_UP`'s bill/receipt), or null. Lives in the
   * separate `credit_resources` table; joined to expose a `hasBill` flag on the
   * ledger without bloating this row. See {@link CreditResource}.
   */
  @OneToOne(() => CreditResource, (r) => r.credit)
  resource: CreditResource | null;

  @CreateDateColumn({ type: 'timestamptz', name: 'created_at', precision: 3 })
  createdAt: Date;
}
