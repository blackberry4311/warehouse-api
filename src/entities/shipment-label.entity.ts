import {
  Column,
  CreateDateColumn,
  Entity,
  JoinColumn,
  OneToOne,
  PrimaryGeneratedColumn,
} from 'typeorm';
import { Shipment } from './shipment.entity';
import { numericTransformer } from './numeric.transformer';

/**
 * The shipping-label image attached to a shipment — the printable label (e.g. a USPS
 * label) the client provides and the warehouse prints. Kept in its own table (not on
 * `shipments`) so the label data can be cleaned up independently of the shipment: once
 * a shipment is DONE or CANCELLED the label is no longer needed, so a daily cron
 * deletes these rows (and their bucket objects) to reclaim storage.
 *
 * Mirrors {@link CreditResource}: the bytes live in object storage via
 * {@link StorageService}; this row only points at the object (`objectKey`) and carries
 * what's needed to serve and expire it. One label per shipment (unique `shipment_id_fk`)
 * — a re-upload replaces it.
 */
@Entity({ schema: 'wh', name: 'shipment_labels' })
export class ShipmentLabel {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  /** The shipment this label belongs to (unique — one per shipment). */
  @Column({ type: 'uuid', name: 'shipment_id_fk' })
  shipmentId: string;

  /** Object-storage key of the stored image. */
  @Column({ type: 'varchar', length: 512, name: 'object_key' })
  objectKey: string;

  @Column({ type: 'varchar', length: 128, name: 'content_type', nullable: true })
  contentType: string | null;

  @Column({ type: 'bigint', nullable: true, transformer: numericTransformer })
  size: number | null;

  @OneToOne(() => Shipment, (s) => s.label, {
    onDelete: 'CASCADE',
    onUpdate: 'CASCADE',
  })
  @JoinColumn({ name: 'shipment_id_fk' })
  shipment: Shipment;

  @CreateDateColumn({ type: 'timestamptz', name: 'created_at', precision: 3 })
  createdAt: Date;
}
