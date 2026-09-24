import { Column, Entity, JoinColumn, ManyToOne, PrimaryColumn, UpdateDateColumn } from 'typeorm';
import { CreditGroup } from './credit-group.entity';
import { FeeType } from './org-fee.entity';
import { numericTransformer } from './numeric.transformer';

/**
 * A credit group's flat fee for an action, mirroring `org_fees` but keyed by credit
 * group. One row per `(credit_group, fee_type)` holds the amount charged to the
 * group's client members when that action is locked — overriding the org fee. A
 * group with no row for a fee_type falls back to the org fee (no markup).
 * Composite PK `(credit_group_id_fk, fee_type)`.
 */
@Entity({ schema: 'wh', name: 'credit_group_fees' })
export class CreditGroupFee {
  @PrimaryColumn({ type: 'uuid', name: 'credit_group_id_fk' })
  creditGroupId: string;

  @PrimaryColumn({ type: 'varchar', length: 50, name: 'fee_type' })
  feeType: FeeType;

  @Column({ type: 'numeric', transformer: numericTransformer })
  amount: number;

  @ManyToOne(() => CreditGroup, (group) => group.fees, {
    onDelete: 'CASCADE',
    onUpdate: 'CASCADE',
  })
  @JoinColumn({ name: 'credit_group_id_fk' })
  creditGroup: CreditGroup;

  @UpdateDateColumn({ type: 'timestamptz', name: 'updated_at', nullable: true })
  updatedAt: Date;
}
