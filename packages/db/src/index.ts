// @ai-pr-review/db: tenant-scoped data access. Raw tables are available from "@ai-pr-review/db/schema"
// and unscoped queries from "@ai-pr-review/db/system"; both are restricted by eslint.config.mjs.
export {
  createDb,
  getRowSecurityStatus,
  withInstallationScope,
  type Database,
  type DbHandle,
  type DbScope,
  type RowSecurityStatus,
} from "./client";
export { runMigrations, MIGRATIONS_FOLDER } from "./migrate";
export * from "./errors";
export * from "./types";
export type { InstallationIds } from "./scope";
export {
  ACTIVE_STATUSES,
  ALLOWED_TRANSITIONS,
  canTransition,
  isActiveStatus,
  isTerminalStatus,
} from "./lifecycle";
export {
  DEFAULT_PAGE_SIZE,
  MAX_PAGE_SIZE,
  decodeCursor,
  encodeCursor,
  type CursorKey,
  type Page,
} from "./pagination";
export { EVIDENCE_MAX_CHARS } from "./schema";
export * from "./tenant";
export * from "./platform";
