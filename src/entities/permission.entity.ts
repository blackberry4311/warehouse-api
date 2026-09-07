import { Column, Entity, PrimaryGeneratedColumn } from 'typeorm';

/** Global permission catalog (names are unique across the system). */
@Entity({ schema: 'wh', name: 'permissions' })
export class Permission {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'varchar', length: 255 })
  name: string;

  @Column({ type: 'text' })
  description: string;

  @Column({ type: 'boolean', name: 'is_group_permission' })
  isGroupPermission: boolean;
}
