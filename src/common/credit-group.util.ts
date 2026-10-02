import { EntityManager } from 'typeorm';
import { NotFoundException } from '@nestjs/common';
import { CreditGroup } from '../entities/credit-group.entity';
import { CreditGroupFee } from '../entities/credit-group-fee.entity';
import { CreditGroupMember } from '../entities/credit-group-member.entity';
import { CreditEntryType, CreditHistory } from '../entities/credit-history.entity';
import { FeeType } from '../entities/org-fee.entity';
import { User } from '../entities/user.entity';
import {
  ActivityAction,
  ActivityEntityType,
  ActivitySummary,
} from '../entities/activity-log.entity';
import { recordActivity } from './activity-log.util';

/**
 * The resolved lock-fee split for a client. Fees are **per-unit rates**: the org's
 * flat fee (`baseRate`) and any credit-group fee are multiplied by the qty being
 * locked (the order's line qty / the shipment's line qty).
 *  - `unitFee` — the per-unit rate the client pays. Equals the client's credit-group
 *    fee when they belong to a credit group with one configured for this `feeType`
 *    (floored at `baseRate` so the markup is never negative); otherwise `baseRate`.
 *  - `charged` — what the client actually pays: `unitFee × qty`.
 *  - `baseCharged` — the warehouse's cut: `baseRate × qty`. The owner's markup is
 *    `charged − baseCharged`.
 *  - `ownerId` — the credit group's owner, credited the markup; null when there is no
 *    override (client is in no credit group, or the group has no fee for this type).
 */
export interface ResolvedClientFee {
  unitFee: number;
  charged: number;
  baseCharged: number;
  ownerId: string | null;
}

/** `rate × qty`, rounded to cents so float error never reaches the `numeric` columns. */
function scaleFee(rate: number, qty: number): number {
  return Math.round(rate * qty * 100) / 100;
}

/**
 * Resolve the amount a client is charged when their order/shipment is locked: the
 * per-unit rate times `qty`. A client's single credit group (per org) may override
 * the org's flat `baseRate` with a marked-up rate; the group's owner then earns the
 * difference (see {@link creditCommission}). Runs inside the lock transaction on the
 * given manager.
 */
export async function resolveClientFee(
  em: EntityManager,
  orgId: string,
  clientUserId: string,
  feeType: FeeType,
  baseRate: number,
  qty: number,
): Promise<ResolvedClientFee> {
  const baseCharged = scaleFee(baseRate, qty);
  const plain: ResolvedClientFee = {
    unitFee: baseRate,
    charged: baseCharged,
    baseCharged,
    ownerId: null,
  };

  const membership = await em.findOne(CreditGroupMember, {
    where: { userId: clientUserId, orgId },
  });
  if (!membership) return plain;

  const groupFee = await em.findOne(CreditGroupFee, {
    where: { creditGroupId: membership.creditGroupId, feeType },
  });
  if (!groupFee) return plain;

  const group = await em.findOne(CreditGroup, { where: { id: membership.creditGroupId } });
  if (!group) return plain;

  // Floor at the org base so the owner's markup can never be negative, even if the
  // group fee was somehow set below the current org fee.
  const unitFee = Math.max(groupFee.amount, baseRate);
  return { unitFee, charged: scaleFee(unitFee, qty), baseCharged, ownerId: group.ownerId };
}

/**
 * Credit a credit-group owner the markup they earned on a lock: a positive
 * `RESELLER_COMMISSION` ledger row plus the wallet update, with the owner's row locked
 * `FOR UPDATE`. Links to the triggering order/shipment and its lock fee. No-op callers
 * should skip this when `amount <= 0`. Runs inside the lock transaction.
 */
export async function creditCommission(
  em: EntityManager,
  params: {
    ownerId: string;
    orgId: string;
    amount: number;
    orderId?: string | null;
    shipmentId?: string | null;
    feeId: string;
    note?: string | null;
    /** Who triggered the lock (the reviewer) — the activity row's actor. */
    actorId: string;
    /** Display reference for the activity summary, e.g. `{ orderNumber }`. */
    reference: ActivitySummary;
  },
): Promise<void> {
  const rows: Array<{ credit: string }> = await em.query(
    `SELECT credit FROM wh.users WHERE id = $1 FOR UPDATE`,
    [params.ownerId],
  );
  if (rows.length === 0) throw new NotFoundException('Credit group owner not found');

  const prevBalance = parseFloat(rows[0].credit);
  const newBalance = prevBalance + params.amount;

  await em.update(User, { id: params.ownerId }, { credit: newBalance });

  const entry = await em.save(
    em.create(CreditHistory, {
      userId: params.ownerId,
      orgId: params.orgId,
      entryType: CreditEntryType.RESELLER_COMMISSION,
      amount: params.amount,
      prevBalance,
      newBalance,
      orderId: params.orderId ?? null,
      shipmentId: params.shipmentId ?? null,
      feeId: params.feeId,
      note: params.note ?? null,
    }),
  );

  await recordActivity(em, {
    orgId: params.orgId,
    actorId: params.actorId,
    subjectUserId: params.ownerId,
    entityType: ActivityEntityType.CREDIT,
    entityId: entry.id,
    action: ActivityAction.CREDIT_COMMISSION,
    summary: { ...params.reference, amount: params.amount, prevBalance, newBalance },
  });
}
