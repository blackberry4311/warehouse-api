import { CreateDateColumn, Entity, JoinColumn, ManyToOne, PrimaryColumn, Column } from 'typeorm';
import { User } from './user.entity';
import { CreditGroup } from './credit-group.entity';

/**
 * Assignment join table: which clients belong to which credit group. The
 * denormalized `org_id_fk` (copied from the group) backs a unique
 * `(user_id_fk, org_id_fk)` index so a client belongs to at most one credit group
 * per org, keeping fee resolution unambiguous. Composite PK
 * `(credit_group_id_fk, user_id_fk)`.
 */
@Entity({ schema: 'wh', name: 'credit_group_members' })
export class CreditGroupMember {
  @PrimaryColumn({ type: 'uuid', name: 'credit_group_id_fk' })
  creditGroupId: string;

  @PrimaryColumn({ type: 'uuid', name: 'user_id_fk' })
  userId: string;

  /** Denormalized from the group so a `(user, org)` unique index can enforce one group per org. */
  @Column({ type: 'uuid', name: 'org_id_fk' })
  orgId: string;

  @ManyToOne(() => CreditGroup, (group) => group.members, {
    onDelete: 'CASCADE',
    onUpdate: 'CASCADE',
  })
  @JoinColumn({ name: 'credit_group_id_fk' })
  creditGroup: CreditGroup;

  @ManyToOne(() => User, { onDelete: 'CASCADE', onUpdate: 'CASCADE' })
  @JoinColumn({ name: 'user_id_fk' })
  user: User;

  @CreateDateColumn({ type: 'timestamptz', name: 'created_at', precision: 3 })
  createdAt: Date;
}
