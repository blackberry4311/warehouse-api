import { Column, Entity, JoinColumn, ManyToOne, PrimaryColumn, UpdateDateColumn } from 'typeorm';
import { Organization } from './organization.entity';
import { numericTransformer } from './numeric.transformer';

/**
 * The kinds of predefined, per-org fees. `ORDER_LOCK` is charged when a reviewer
 * locks an order; `SHIPMENT_REQUEST` is reserved for the upcoming shipment flow.
 * Values match the `org_fees.fee_type` CHECK and the charge-type entries in
 * `CreditEntryType`.
 */
export enum FeeType {
  ORDER_LOCK = 'ORDER_LOCK',
  SHIPMENT_REQUEST = 'SHIPMENT_REQUEST',
}

/**
 * Per-organization flat fee for an action. One row per (org, fee_type) holds the
 * predefined amount charged against a client's credit. An org with no row for a
 * fee_type is treated as fee 0 (not charged). Composite PK `(org_id_fk, fee_type)`.
 */
@Entity({ schema: 'wh', name: 'org_fees' })
export class OrgFee {
  @PrimaryColumn({ type: 'uuid', name: 'org_id_fk' })
  orgId: string;

  @PrimaryColumn({ type: 'varchar', length: 50, name: 'fee_type' })
  feeType: FeeType;

  @Column({ type: 'numeric', transformer: numericTransformer })
  amount: number;

  @ManyToOne(() => Organization, { onDelete: 'CASCADE', onUpdate: 'CASCADE' })
  @JoinColumn({ name: 'org_id_fk' })
  organization: Organization;

  @UpdateDateColumn({ type: 'timestamptz', name: 'updated_at', nullable: true })
  updatedAt: Date;
}
