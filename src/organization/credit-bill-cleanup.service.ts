import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { OrganizationService } from './organization.service';
import { BILL_TTL_DAYS } from '../common/credit-bill.util';

/**
 * Deletes top-up bills older than {@link BILL_TTL_DAYS}. Railway Buckets' support
 * for native S3 lifecycle rules isn't documented, so we expire them ourselves — a
 * daily job that drops the object and clears the row's bill columns in one pass, so
 * storage and DB never drift. Delegates the work to
 * {@link OrganizationService.expireOldBills}.
 */
@Injectable()
export class CreditBillCleanupService {
  private readonly logger = new Logger(CreditBillCleanupService.name);

  constructor(private readonly orgService: OrganizationService) {}

  @Cron(CronExpression.EVERY_DAY_AT_3AM)
  async handleExpiry(): Promise<void> {
    try {
      const removed = await this.orgService.expireOldBills(BILL_TTL_DAYS);
      if (removed > 0)
        this.logger.log(`Expired ${removed} top-up bill(s) older than ${BILL_TTL_DAYS} days`);
    } catch (err) {
      this.logger.error(`Bill expiry run failed: ${(err as Error).message}`);
    }
  }
}
