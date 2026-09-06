import { CreateDateColumn, Entity, JoinColumn, ManyToOne, PrimaryColumn } from 'typeorm';
import { User } from './user.entity';
import { Organization } from './organization.entity';

/** Membership join table: which users belong to which organizations. */
@Entity({ schema: 'wh', name: 'users_orgs' })
export class UserOrg {
  @PrimaryColumn({ type: 'uuid', name: 'user_id_fk' })
  userId: string;

  @PrimaryColumn({ type: 'uuid', name: 'org_id_fk' })
  orgId: string;

  @ManyToOne(() => User, { onDelete: 'CASCADE', onUpdate: 'CASCADE' })
  @JoinColumn({ name: 'user_id_fk' })
  user: User;

  @ManyToOne(() => Organization, { onDelete: 'CASCADE', onUpdate: 'CASCADE' })
  @JoinColumn({ name: 'org_id_fk' })
  organization: Organization;

  @CreateDateColumn({ type: 'timestamptz', name: 'created_at' })
  createdAt: Date;
}
