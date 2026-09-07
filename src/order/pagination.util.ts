import { BadRequestException } from '@nestjs/common';

/** A page of results plus the cursor to fetch the next page (null when exhausted). */
export interface Page<T> {
  items: T[];
  nextCursor: string | null;
}

/** What a cursor encodes: the last row's created_at (ISO) + id tiebreaker. */
interface CursorPayload {
  t: string;
  id: string;
}

export const DEFAULT_LIMIT = 20;
export const MAX_LIMIT = 100;

/** Parse the raw `limit` query string into a clamped positive integer. */
export function parseLimit(raw?: string): number {
  if (raw === undefined || raw === '') return DEFAULT_LIMIT;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1) {
    throw new BadRequestException('limit must be a positive integer');
  }
  return Math.min(n, MAX_LIMIT);
}

export function encodeCursor(row: { createdAt: Date; id: string }): string {
  const payload: CursorPayload = { t: row.createdAt.toISOString(), id: row.id };
  return Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
}

export function decodeCursor(cursor: string): CursorPayload {
  try {
    const payload = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as CursorPayload;
    if (typeof payload.t !== 'string' || typeof payload.id !== 'string') {
      throw new Error('bad shape');
    }
    if (Number.isNaN(Date.parse(payload.t))) throw new Error('bad date');
    return payload;
  } catch {
    throw new BadRequestException('Invalid cursor');
  }
}

/**
 * Slice `rows` (fetched as limit + 1) into a page: keep `limit` rows and, if an
 * extra row was returned, emit the cursor pointing past the last kept row.
 */
export function toPage<T extends { id: string; createdAt: Date }>(
  rows: T[],
  limit: number,
): Page<T> {
  const hasMore = rows.length > limit;
  const items = hasMore ? rows.slice(0, limit) : rows;
  const last = items[items.length - 1];
  return { items, nextCursor: hasMore && last ? encodeCursor(last) : null };
}
