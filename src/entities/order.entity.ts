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
  /** Placed by the client, goods not yet received. */
  PENDING = 'PENDING',
  /** Operation confirmed the goods and stored them. */
  IN_WAREHOUSE = 'IN_WAREHOUSE',
  /** Partial withdrawals underway (future flow). */
  PROCESSING = 'PROCESSING',
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

  @Column({ type: 'varchar', length: 50, default: OrderStatus.PENDING })
  status: OrderStatus;

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
