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
import { User } from './user.entity';
import { numericTransformer } from './numeric.transformer';

/**
 * Why a user's credit changed. The charge types (`ORDER_LOCK`, `SHIPMENT_REQUEST`)
 * mirror `FeeType` and are what warehouse earnings sum over; `TOP_UP` and
 * `ADJUSTMENT` cover the client adding funds and manual corrections.
 */
export enum CreditEntryType {
  /** Charged when a reviewer locks the client's order. */
  ORDER_LOCK = 'ORDER_LOCK',
  /** Reserved for the upcoming shipment-request flow. */
  SHIPMENT_REQUEST = 'SHIPMENT_REQUEST',
  /** The client added funds. */
  TOP_UP = 'TOP_UP',
  /** Manual correction. */
  ADJUSTMENT = 'ADJUSTMENT',
}

/**
 * Append-only ledger of every change to a user's credit. `amount` is the signed
 * delta (negative = charge, positive = top-up/refund) so `newBalance = prevBalance
 * + amount` always holds; `order` links a charge to the order that triggered it.
 * Warehouse earnings for an org over a period = `-SUM(amount)` over the charge
 * entry types.
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

  @CreateDateColumn({ type: 'timestamptz', name: 'created_at', precision: 3 })
  createdAt: Date;
}
