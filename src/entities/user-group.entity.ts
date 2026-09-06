import { CreateDateColumn, Entity, JoinColumn, ManyToOne, PrimaryColumn } from 'typeorm';
import { User } from './user.entity';
import { OrgGroup } from './org-group.entity';

/** Assignment join table: which users belong to which groups. */
@Entity({ schema: 'wh', name: 'user_groups' })
export class UserGroup {
  @PrimaryColumn({ type: 'uuid', name: 'user_id_fk' })
  userId: string;

  @PrimaryColumn({ type: 'uuid', name: 'group_id_fk' })
  groupId: string;

  @ManyToOne(() => User, { onDelete: 'CASCADE', onUpdate: 'CASCADE' })
  @JoinColumn({ name: 'user_id_fk' })
  user: User;

  @ManyToOne(() => OrgGroup, { onDelete: 'CASCADE', onUpdate: 'CASCADE' })
  @JoinColumn({ name: 'group_id_fk' })
  group: OrgGroup;

  @CreateDateColumn({ type: 'timestamptz', name: 'created_at' })
  createdAt: Date;
}
