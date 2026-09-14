import {
  Column,
  CreateDateColumn,
  Entity,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
} from 'typeorm';
import { Shipment, ShipmentStatus } from './shipment.entity';
import { User } from './user.entity';
import { numericTransformer } from './numeric.transformer';

export enum ShipmentChangeType {
  CREATED = 'CREATED',
  STATUS_CHANGE = 'STATUS_CHANGE',
  /** The client edited the shipment's line items while still unlocked. */
  ITEM_CHANGE = 'ITEM_CHANGE',
  /** A reviewer (`review_shipment`) locked the shipment, handing it to operations. */
  LOCKED = 'LOCKED',
}

/**
 * Append-only audit trail for a shipment — the mirror of `order_history`. One row
 * per change; a CREATED row is written on placement. `prev_qty`/`new_qty` hold the
 * shipment's **total** quantity (summed across all its order lines) at the time,
 * since the per-line breakdown lives on `shipment_details`.
 */
@Entity({ schema: 'wh', name: 'shipment_history' })
export class ShipmentHistory {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'uuid', name: 'shipment_id_fk' })
  shipmentId: string;

  /** The user who made the change. */
  @Column({ type: 'uuid', name: 'changed_by_fk' })
  changedBy: string;

  /** Relation to the changing user, layered on `changed_by_fk`. */
  @ManyToOne(() => User, { onUpdate: 'CASCADE' })
  @JoinColumn({ name: 'changed_by_fk' })
  changedByUser: User;

  @Column({ type: 'varchar', length: 50, name: 'change_type' })
  changeType: ShipmentChangeType;

  @Column({ type: 'varchar', length: 50, name: 'prev_status', nullable: true })
  prevStatus: ShipmentStatus | null;

  @Column({ type: 'varchar', length: 50, name: 'new_status', nullable: true })
  newStatus: ShipmentStatus | null;

  @Column({ type: 'numeric', name: 'prev_qty', nullable: true, transformer: numericTransformer })
  prevQty: number | null;

  @Column({ type: 'numeric', name: 'new_qty', nullable: true, transformer: numericTransformer })
  newQty: number | null;

  @Column({ type: 'text', nullable: true })
  note: string | null;

  @ManyToOne(() => Shipment, { onDelete: 'CASCADE', onUpdate: 'CASCADE' })
  @JoinColumn({ name: 'shipment_id_fk' })
  shipment: Shipment;

  @CreateDateColumn({ type: 'timestamptz', name: 'created_at', precision: 3 })
  createdAt: Date;
}
