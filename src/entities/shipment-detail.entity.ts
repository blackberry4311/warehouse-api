import { Column, Entity, JoinColumn, ManyToOne, PrimaryColumn } from 'typeorm';
import { Shipment } from './shipment.entity';
import { Order } from './order.entity';
import { numericTransformer } from './numeric.transformer';

/**
 * A shipment detail line: one order a shipment draws from, and the quantity shipped
 * out of that order in this shipment — the many-to-many join between shipments and
 * orders (a shipment references each order at most once, so the composite PK
 * `(shipment_id_fk, order_id_fk)` is also a uniqueness guarantee). At lock time each
 * row's `qty` is added to its order's `shipped_qty`.
 */
@Entity({ schema: 'wh', name: 'shipment_details' })
export class ShipmentDetail {
  @PrimaryColumn({ type: 'uuid', name: 'shipment_id_fk' })
  shipmentId: string;

  @PrimaryColumn({ type: 'uuid', name: 'order_id_fk' })
  orderId: string;

  /** Quantity shipped out of this order in this shipment. */
  @Column({ type: 'numeric', transformer: numericTransformer })
  qty: number;

  @ManyToOne(() => Shipment, (shipment) => shipment.items, {
    onDelete: 'CASCADE',
    onUpdate: 'CASCADE',
  })
  @JoinColumn({ name: 'shipment_id_fk' })
  shipment: Shipment;

  @ManyToOne(() => Order, { onDelete: 'CASCADE', onUpdate: 'CASCADE' })
  @JoinColumn({ name: 'order_id_fk' })
  order: Order;
}
