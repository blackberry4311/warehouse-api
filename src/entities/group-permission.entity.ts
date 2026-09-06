import { CreateDateColumn, Entity, JoinColumn, ManyToOne, PrimaryColumn } from 'typeorm';
import { OrgGroup } from './org-group.entity';
import { Permission } from './permission.entity';

/** Grant join table: which permissions a group holds. */
@Entity({ schema: 'wh', name: 'group_permissions' })
export class GroupPermission {
  @PrimaryColumn({ type: 'uuid', name: 'group_id_fk' })
  groupId: string;

  @PrimaryColumn({ type: 'uuid', name: 'permission_id_fk' })
  permissionId: string;

  @ManyToOne(() => OrgGroup, { onDelete: 'CASCADE', onUpdate: 'CASCADE' })
  @JoinColumn({ name: 'group_id_fk' })
  group: OrgGroup;

  @ManyToOne(() => Permission, { onDelete: 'CASCADE', onUpdate: 'CASCADE' })
  @JoinColumn({ name: 'permission_id_fk' })
  permission: Permission;

  @CreateDateColumn({ type: 'timestamptz', name: 'created_at' })
  createdAt: Date;
}
