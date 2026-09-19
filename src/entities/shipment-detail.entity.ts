import { Column, Entity, JoinColumn, ManyToOne, PrimaryColumn } from 'typeorm';
import { Shipment } from './shipment.entity';
import { OrderDetail } from './order-detail.entity';
import { numericTransformer } from './numeric.transformer';

/**
 * A shipment detail line: one **order line item** (`order_details`) a shipment draws
 * from, and the quantity shipped out of that line in this shipment — the many-to-many
 * join between shipments and order line items (a shipment references each line at most
 * once, so the composite PK `(shipment_id_fk, order_detail_id_fk)` is also a uniqueness
 * guarantee). At lock time each row's `qty` is added to its line's `shipped_qty`.
 *
 * Phase 2 repointed this from the order header (`order_id_fk`) onto the line item:
 * inventory — and therefore what a shipment can withdraw — lives per-line now.
 */
@Entity({ schema: 'wh', name: 'shipment_details' })
export class ShipmentDetail {
  @PrimaryColumn({ type: 'uuid', name: 'shipment_id_fk' })
  shipmentId: string;

  @PrimaryColumn({ type: 'uuid', name: 'order_detail_id_fk' })
  orderDetailId: string;

  /** Quantity shipped out of this order line in this shipment. */
  @Column({ type: 'numeric', transformer: numericTransformer })
  qty: number;

  @ManyToOne(() => Shipment, (shipment) => shipment.items, {
    onDelete: 'CASCADE',
    onUpdate: 'CASCADE',
  })
  @JoinColumn({ name: 'shipment_id_fk' })
  shipment: Shipment;

  @ManyToOne(() => OrderDetail, { onDelete: 'CASCADE', onUpdate: 'CASCADE' })
  @JoinColumn({ name: 'order_detail_id_fk' })
  orderDetail: OrderDetail;
}
