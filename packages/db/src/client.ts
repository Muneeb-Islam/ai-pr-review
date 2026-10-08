import { sql } from "drizzle-orm";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import pg from "pg";
import * as schema from "./schema";

export type Database = NodePgDatabase<typeof schema>;

export interface DbHandle {
  db: Database;
  pool: pg.Pool;
  close(): Promise<void>;
}

/**
 * Which row-level-security scope a connection pool starts in (migration 0006).
 *  - `system`: every connection announces `aipr.scope = system`: the worker, webhook handlers and jobs, which act
 *    for the platform and read across tenants by design. The default.
 *  - `tenant`: no scope announced. Tenant tables show nothing until `withInstallationScope` names the installations
 *    a transaction may see. The dashboard API uses this for its handlers.
 * Both only matter when the database role is subject to row-level security (not a superuser, not the table owner).
 */
export type DbScope = "system" | "tenant";

/** Opens a connection pool. Callers own the handle and must `close()` it on shutdown. */
export function createDb(
  connectionString: string,
  options: { max?: number; scope?: DbScope } = {},
): DbHandle {
  const pool = new pg.Pool({
    connectionString,
    max: options.max ?? 10,
    ...((options.scope ?? "system") === "system" ? { options: "-c aipr.scope=system" } : {}),
  });
  const db = drizzle(pool, { schema });
  return { db, pool, close: () => pool.end() };
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Runs `fn` in a transaction whose tenant tables show only the given installations (row-level security,
 * design §9). Everything `fn` does with the scoped handle is one transaction. Malformed ids are dropped; an empty
 * list shows nothing. The function must not hold the transaction across slow outside calls longer than needed.
 */
export async function withInstallationScope<T>(
  db: Database,
  installationIds: readonly string[],
  fn: (scoped: Database) => Promise<T>,
): Promise<T> {
  const ids = installationIds.filter((id) => UUID.test(id)).join(",");
  return db.transaction(async (tx) => {
    // The functions of the data layer run independent queries side by side (`Promise.all`), which a pool turns into
    // parallel connections. A transaction has one connection, and node-postgres deprecates a second query while
    // one is running: queue them instead, in the order they were issued, for the length of the transaction.
    const restore = serializeQueries(tx);
    try {
      // `true` = local to this transaction: the setting disappears with it and never leaks into the pool.
      await tx.execute(sql`select set_config('aipr.installation_ids', ${ids}, true)`);
      return await fn(tx as unknown as Database);
    } finally {
      restore();
    }
  });
}

type QueryFn = (...args: unknown[]) => Promise<unknown>;

/**
 * Makes the connection behind a drizzle transaction run its queries one after the other. Returns the function that
 * puts the original `query` back (the connection returns to the pool afterwards). Feature-detected: if drizzle's
 * internals change shape, queries simply run as before.
 */
function serializeQueries(tx: unknown): () => void {
  const client = (tx as { session?: { client?: { query?: unknown } } }).session?.client;
  if (!client || typeof client.query !== "function") return () => undefined;
  const original = client.query as QueryFn;
  let tail: Promise<unknown> = Promise.resolve();
  client.query = (...args: unknown[]) => {
    const run = () => original.apply(client, args);
    const result = tail.then(run, run);
    tail = result.catch(() => undefined);
    return result;
  };
  return () => {
    client.query = original;
  };
}

export interface RowSecurityStatus {
  role: string;
  /** False when the role is a superuser, has BYPASSRLS or owns the tables: the policies do not apply to it. */
  enforced: boolean;
}

/** Whether the connected role is subject to the tenant policies. Checked at startup; reported by `/metrics`. */
export async function getRowSecurityStatus(db: Database): Promise<RowSecurityStatus> {
  const result = await db.execute<{
    rolname: string;
    rolsuper: boolean;
    rolbypassrls: boolean;
    owns: boolean | null;
  }>(sql`
    select r.rolname, r.rolsuper, r.rolbypassrls,
      (select pg_get_userbyid(c.relowner) = current_user
         from pg_class c
        where c.relname = 'review_runs' and c.relnamespace = 'public'::regnamespace) as owns
    from pg_roles r
    where r.rolname = current_user
  `);
  const row = result.rows[0];
  if (!row) return { role: "unknown", enforced: false };
  return { role: row.rolname, enforced: !row.rolsuper && !row.rolbypassrls && !row.owns };
}
