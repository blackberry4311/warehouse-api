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
import { CreditGroupFee } from './credit-group-fee.entity';
import { CreditGroupMember } from './credit-group-member.entity';

/**
 * A **credit group**: a billing-only construct (unrelated to the permission
 * `org_groups`) used to give a set of clients a marked-up lock fee.
 *
 * Each group is scoped to one org, has an `owner` (the reviewer/reseller who earns
 * the markup), its own per-`fee_type` amounts (`credit_group_fees`) and a set of
 * client members (`credit_group_members`). When a member's order/shipment is locked,
 * the group's fee overrides the org's flat fee as the amount charged to the client;
 * the org fee is the warehouse's cut and the difference (group fee − org fee) is
 * credited to the owner's wallet. A client belongs to at most one credit group per
 * org (enforced by a unique index on `credit_group_members`), so the fee is
 * unambiguous.
 */
@Entity({ schema: 'wh', name: 'credit_groups' })
export class CreditGroup {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'varchar', length: 255 })
  name: string;

  @Column({ type: 'uuid', name: 'org_id_fk' })
  orgId: string;

  /** The reviewer/reseller who earns the markup (group fee − org fee) on each lock. */
  @Column({ type: 'uuid', name: 'owner_id_fk' })
  ownerId: string;

  @ManyToOne(() => Organization, { onDelete: 'CASCADE', onUpdate: 'CASCADE' })
  @JoinColumn({ name: 'org_id_fk' })
  organization: Organization;

  /** Relation to the owning user, layered on `owner_id_fk` (safe columns only). */
  @ManyToOne(() => User, { onUpdate: 'CASCADE' })
  @JoinColumn({ name: 'owner_id_fk' })
  owner: User;

  @OneToMany(() => CreditGroupFee, (fee) => fee.creditGroup)
  fees: CreditGroupFee[];

  @OneToMany(() => CreditGroupMember, (member) => member.creditGroup)
  members: CreditGroupMember[];

  @CreateDateColumn({ type: 'timestamptz', name: 'created_at', precision: 3 })
  createdAt: Date;

  @UpdateDateColumn({ type: 'timestamptz', name: 'updated_at', nullable: true })
  updatedAt: Date;
}
