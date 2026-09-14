import { Column, Entity, PrimaryColumn } from 'typeorm';

/**
 * Per-(user, org) monotonic counter feeding shipment numbers — the mirror of
 * `order_sequences`. Bumped atomically inside the place-shipment transaction with
 * an `INSERT ... ON CONFLICT DO UPDATE ... RETURNING`, so it is rarely read through
 * the repository directly.
 */
@Entity({ schema: 'wh', name: 'shipment_sequences' })
export class ShipmentSequence {
  @PrimaryColumn({ type: 'uuid', name: 'user_id_fk' })
  userId: string;

  @PrimaryColumn({ type: 'uuid', name: 'org_id_fk' })
  orgId: string;

  @Column({ type: 'bigint', name: 'next_seq', default: 0 })
  nextSeq: string;
}
