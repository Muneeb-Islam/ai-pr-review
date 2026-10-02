import { sql, type SQL } from "drizzle-orm";
import type { AnyPgColumn } from "drizzle-orm/pg-core";
import { InvalidCursorError } from "./errors";

export const DEFAULT_PAGE_SIZE = 25;
export const MAX_PAGE_SIZE = 100;

export interface Page<T> {
  items: T[];
  /** Pass back as `cursor` to get the next page; null when there are no more rows. */
  nextCursor: string | null;
}

export interface CursorKey {
  at: Date;
  id: string;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Opaque cursor over the sort key `(timestamp, id)`. Timestamps have millisecond precision in the schema. */
export function encodeCursor(key: CursorKey): string {
  return Buffer.from(JSON.stringify([key.at.toISOString(), key.id])).toString("base64url");
}

export function decodeCursor(cursor: string): CursorKey {
  try {
    const parsed: unknown = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
    if (Array.isArray(parsed) && parsed.length === 2) {
      const [iso, id] = parsed as unknown[];
      if (typeof iso === "string" && typeof id === "string" && UUID.test(id)) {
        const at = new Date(iso);
        if (!Number.isNaN(at.getTime()) && at.toISOString() === iso) return { at, id };
      }
    }
  } catch {
    // fall through
  }
  throw new InvalidCursorError();
}

export function clampLimit(limit: number | undefined): number {
  if (limit === undefined) return DEFAULT_PAGE_SIZE;
  if (!Number.isInteger(limit) || limit < 1) return DEFAULT_PAGE_SIZE;
  return Math.min(limit, MAX_PAGE_SIZE);
}

/** Keyset condition for rows ordered by `(at desc, id desc)`: strictly after the cursor row. */
export function afterCursor(at: AnyPgColumn, id: AnyPgColumn, cursor: string): SQL {
  const key = decodeCursor(cursor);
  return sql`(${at}, ${id}) < (${key.at.toISOString()}::timestamptz, ${key.id}::uuid)`;
}

/**
 * Builds a page from rows fetched with `limit + 1`. The extra row only signals that more exist; it is
 * dropped from the page and the cursor points at the last row that is returned.
 */
export function toPage<T>(rows: T[], limit: number, keyOf: (row: T) => CursorKey): Page<T> {
  const items = rows.slice(0, limit);
  const last = items[items.length - 1];
  const hasMore = rows.length > limit && last !== undefined;
  return { items, nextCursor: hasMore ? encodeCursor(keyOf(last)) : null };
}
