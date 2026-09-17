import {
  Column,
  CreateDateColumn,
  Entity,
  JoinColumn,
  OneToOne,
  PrimaryGeneratedColumn,
} from 'typeorm';
import { CreditHistory } from './credit-history.entity';
import { numericTransformer } from './numeric.transformer';

/**
 * A file resource attached to a credit ledger entry — today the bill/receipt image
 * for a `TOP_UP`. Kept in its own table (not on `credit_history`) so the append-only
 * ledger stays lean and this data can be cleaned up independently: bills auto-expire
 * after two weeks by simply deleting rows here (plus their bucket objects), leaving
 * the immutable ledger entry untouched.
 *
 * The bytes live in object storage via {@link StorageService}; this row only points
 * at the object (`objectKey`) and carries what's needed to serve and expire it. One
 * resource per credit entry (unique `credit_id_fk`) — a re-upload replaces it.
 */
@Entity({ schema: 'wh', name: 'credit_resources' })
export class CreditResource {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  /** The credit_history entry this resource belongs to (unique — one per entry). */
  @Column({ type: 'uuid', name: 'credit_id_fk' })
  creditId: string;

  /** Object-storage key of the stored file. */
  @Column({ type: 'varchar', length: 512, name: 'object_key' })
  objectKey: string;

  @Column({ type: 'varchar', length: 128, name: 'content_type', nullable: true })
  contentType: string | null;

  @Column({ type: 'bigint', nullable: true, transformer: numericTransformer })
  size: number | null;

  @OneToOne(() => CreditHistory, (c) => c.resource, {
    onDelete: 'CASCADE',
    onUpdate: 'CASCADE',
  })
  @JoinColumn({ name: 'credit_id_fk' })
  credit: CreditHistory;

  @CreateDateColumn({ type: 'timestamptz', name: 'created_at', precision: 3 })
  createdAt: Date;
}
