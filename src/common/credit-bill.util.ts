import { CreditHistory } from '../entities/credit-history.entity';
import { Page } from './pagination.util';

/** How long a top-up bill is kept before the daily cleanup cron deletes it. */
export const BILL_TTL_DAYS = 14;

/**
 * Lifetime of a presigned bill-view URL. Kept independent of (and ≤) the retention
 * above: 7 days is the standard S3 SigV4 max, so this stays valid on R2 / MinIO /
 * AWS as well as Railway Buckets. The FE re-requests a URL when one expires.
 */
export const BILL_URL_TTL_SECONDS = 7 * 24 * 60 * 60;

/** A ledger row as returned to clients: the `resource` relation collapsed to a flag. */
export type CreditHistoryView = Omit<CreditHistory, 'resource'> & { hasBill: boolean };

/**
 * Collapse each row's `resource` relation into a `hasBill` boolean and drop the raw
 * relation, so the ledger says whether a bill exists without leaking its storage key.
 * The caller must have joined `c.resource` (e.g. `leftJoin` + `addSelect('resource.id')`).
 * Shared by the two credit-history read paths (org-scoped and per-user).
 */
export function attachBillFlag(page: Page<CreditHistory>): Page<CreditHistoryView> {
  return {
    nextCursor: page.nextCursor,
    items: page.items.map(({ resource, ...rest }) => ({
      ...rest,
      hasBill: resource != null,
    })),
  };
}
