import {
  Column,
  CreateDateColumn,
  Entity,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';

@Entity({ schema: 'wh', name: 'users' })
export class User {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'varchar', nullable: true })
  email: string;

  @Column({ type: 'varchar', nullable: true, name: 'password_hash' })
  passwordHash: string;

  @Column({ type: 'varchar', nullable: true, name: 'display_name' })
  displayName: string;

  /** System super-admin: bypasses all permission checks (see PermissionsGuard). */
  @Column({ type: 'boolean', name: 'is_admin', default: false })
  isAdmin: boolean;

  /** Per-user client code used to build order numbers (e.g. ACME-000123). */
  @Column({ type: 'varchar', length: 16, nullable: true })
  code: string | null;

  @CreateDateColumn({ type: 'timestamptz', name: 'created_at' })
  createdAt: Date;

  @UpdateDateColumn({ type: 'timestamptz', name: 'updated_at' })
  updatedAt: Date;
}
