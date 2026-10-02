import { inArray, sql, type SQL } from "drizzle-orm";
import type { AnyPgColumn } from "drizzle-orm/pg-core";

/**
 * The installations a caller may access (resolved from `user_installations`, see
 * `system.listAccessibleInstallationIds`). Every tenant read takes this; an empty list matches nothing.
 */
export type InstallationIds = readonly string[];

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isUuid(value: string): boolean {
  return UUID.test(value);
}

/** `column IN (ids)`; an empty or malformed scope yields `false` rather than an error or a wildcard. */
export function inInstallations(column: AnyPgColumn, ids: InstallationIds): SQL {
  const valid = ids.filter(isUuid);
  return valid.length === 0 ? sql`false` : inArray(column, valid);
}
