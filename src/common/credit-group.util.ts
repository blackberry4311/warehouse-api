import { EntityManager } from 'typeorm';
import { NotFoundException } from '@nestjs/common';
import { CreditGroup } from '../entities/credit-group.entity';
import { CreditGroupFee } from '../entities/credit-group-fee.entity';
import { CreditGroupMember } from '../entities/credit-group-member.entity';
import { CreditEntryType, CreditHistory } from '../entities/credit-history.entity';
import { FeeType } from '../entities/org-fee.entity';
import { User } from '../entities/user.entity';

/**
 * The resolved lock-fee split for a client, given the org's flat fee (`base`):
 *  - `charged` — what the client actually pays. Equals the client's credit-group fee
 *    when they belong to a credit group with one configured for this `feeType`
 *    (floored at `base` so the markup is never negative); otherwise `base`.
 *  - `ownerId` — the credit group's owner, credited the markup; null when there is no
 *    override (client is in no credit group, or the group has no fee for this type).
 */
export interface ResolvedClientFee {
  charged: number;
  ownerId: string | null;
}

/**
 * Resolve the amount a client is charged when their order/shipment is locked. A
 * client's single credit group (per org) may override the org's flat `base` fee with
 * a marked-up amount; the group's owner then earns the difference (see
 * {@link creditCommission}). Runs inside the lock transaction on the given manager.
 */
export async function resolveClientFee(
  em: EntityManager,
  orgId: string,
  clientUserId: string,
  feeType: FeeType,
  base: number,
): Promise<ResolvedClientFee> {
  const membership = await em.findOne(CreditGroupMember, {
    where: { userId: clientUserId, orgId },
  });
  if (!membership) return { charged: base, ownerId: null };

  const groupFee = await em.findOne(CreditGroupFee, {
    where: { creditGroupId: membership.creditGroupId, feeType },
  });
  if (!groupFee) return { charged: base, ownerId: null };

  const group = await em.findOne(CreditGroup, { where: { id: membership.creditGroupId } });
  if (!group) return { charged: base, ownerId: null };

  // Floor at the org base so the owner's markup can never be negative, even if the
  // group fee was somehow set below the current org fee.
  const charged = Math.max(groupFee.amount, base);
  return { charged, ownerId: group.ownerId };
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

  await em.save(
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
}
