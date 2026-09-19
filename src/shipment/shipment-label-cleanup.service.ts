import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { ShipmentService } from './shipment.service';

/**
 * Deletes shipping labels attached to shipments that have reached DONE/CANCELLED — a
 * label is only needed until the shipment is fulfilled or cancelled, so keeping it
 * afterwards just wastes bucket storage. A daily job drops the object and the row in
 * one pass, so storage and DB never drift. Delegates to
 * {@link ShipmentService.expireLabelsForClosedShipments}. (Mirrors
 * CreditBillCleanupService — labels expire by shipment status, not by age.)
 */
@Injectable()
export class ShipmentLabelCleanupService {
  private readonly logger = new Logger(ShipmentLabelCleanupService.name);

  constructor(private readonly shipmentService: ShipmentService) {}

  @Cron(CronExpression.EVERY_DAY_AT_3AM)
  async handleExpiry(): Promise<void> {
    try {
      const removed = await this.shipmentService.expireLabelsForClosedShipments();
      if (removed > 0) this.logger.log(`Expired ${removed} shipment label(s) on closed shipments`);
    } catch (err) {
      this.logger.error(`Shipment label expiry run failed: ${(err as Error).message}`);
    }
  }
}
