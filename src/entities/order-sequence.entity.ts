import { Column, Entity, PrimaryColumn } from 'typeorm';

/**
 * Per-(user, org) monotonic counter feeding order numbers. Rows are bumped
 * atomically inside the place-order transaction with an
 * `INSERT ... ON CONFLICT DO UPDATE ... RETURNING`, so it is rarely read
 * through the repository directly — the entity exists mainly for registration.
 */
@Entity({ schema: 'wh', name: 'order_sequences' })
export class OrderSequence {
  @PrimaryColumn({ type: 'uuid', name: 'user_id_fk' })
  userId: string;

  @PrimaryColumn({ type: 'uuid', name: 'org_id_fk' })
  orgId: string;

  @Column({ type: 'bigint', name: 'next_seq', default: 0 })
  nextSeq: string;
}
