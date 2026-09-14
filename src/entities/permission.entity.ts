import { Column, Entity, PrimaryGeneratedColumn } from 'typeorm';

/**
 * Which functional area a permission belongs to, so the FE can render the
 * catalog grouped. A fixed, developer-authored taxonomy that mirrors the module
 * layout; values match the `permissions.category` CHECK in `scripts/init.sql`.
 */
export enum PermissionCategory {
  ORDER = 'order',
  SHIPMENT = 'shipment',
  ORGANIZATION = 'organization',
  ACCESS_CONTROL = 'access_control',
}

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

  @Column({ type: 'varchar', length: 32 })
  category: PermissionCategory;
}
