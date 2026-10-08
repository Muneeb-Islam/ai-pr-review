// Test helper: a real PostgreSQL database per test file (no mocks). Each file gets a fresh, empty
// database that is migrated to latest, so every test run also proves "empty -> latest".
import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { createDb, type DbHandle, type DbScope } from "../client";
import { runMigrations } from "../migrate";

const DEFAULT_URL = "postgres://aipr:aipr@localhost:5432/aipr";

/** DATABASE_URL from the environment, falling back to the repo-level .env, then the compose default. */
export function adminDatabaseUrl(): string {
  if (!process.env.DATABASE_URL) {
    const envFile = fileURLToPath(new URL("../../../../.env", import.meta.url));
    if (existsSync(envFile)) process.loadEnvFile(envFile);
  }
  return process.env.DATABASE_URL || DEFAULT_URL;
}

export interface TestDatabase extends DbHandle {
  url: string;
  name: string;
  /** Closes the pool and drops the database. */
  drop(): Promise<void>;
}

export async function createTestDatabase(
  options: { migrate?: boolean } = {},
): Promise<TestDatabase> {
  const adminUrl = adminDatabaseUrl();
  const name = `aipr_test_${randomBytes(6).toString("hex")}`;

  const admin = new pg.Client({ connectionString: adminUrl });
  try {
    await admin.connect();
  } catch (err) {
    throw new Error(
      `Cannot reach PostgreSQL for tests (${(err as Error).message}). ` +
        "Start it with `npm run db:up` and make sure DATABASE_URL is correct.",
      { cause: err },
    );
  }
  await admin.query(`create database "${name}"`);
  await admin.end();

  const url = new URL(adminUrl);
  url.pathname = `/${name}`;
  const handle = createDb(url.toString(), { max: 5 });
  if (options.migrate !== false) await runMigrations(handle.db);

  return {
    ...handle,
    url: url.toString(),
    name,
    async drop() {
      await handle.close();
      const cleanup = new pg.Client({ connectionString: adminUrl });
      await cleanup.connect();
      await cleanup.query(`drop database if exists "${name}" with (force)`);
      await cleanup.end();
    },
  };
}

/** A plain role for tests of row-level security: no superuser, no BYPASSRLS, and it owns nothing. */
export const APP_ROLE = "aipr_app_test";
const APP_ROLE_PASSWORD = "aipr_app_test";

/**
 * Opens a pool on the test database as `APP_ROLE`, the way production runs the apps: subject to the tenant
 * policies of migration 0006 (the superuser that created the database is not). The role is created once per
 * server (roles are cluster-wide), so concurrent test files are serialised with an advisory lock.
 */
export async function createAppRoleHandle(
  t: TestDatabase,
  options: { scope?: DbScope; max?: number } = {},
): Promise<DbHandle> {
  const admin = new pg.Client({ connectionString: t.url });
  await admin.connect();
  try {
    await admin.query("select pg_advisory_lock(7015001)");
    await admin.query(`do $$ begin
      if not exists (select from pg_roles where rolname = '${APP_ROLE}') then
        create role ${APP_ROLE} login password '${APP_ROLE_PASSWORD}' nosuperuser nobypassrls nocreatedb nocreaterole;
      end if;
    end $$`);
    await admin.query(`grant connect on database "${t.name}" to ${APP_ROLE}`);
    await admin.query(`grant usage on schema public to ${APP_ROLE}`);
    await admin.query(
      `grant select, insert, update, delete on all tables in schema public to ${APP_ROLE}`,
    );
    await admin.query(`grant usage, select on all sequences in schema public to ${APP_ROLE}`);
    await admin.query("select pg_advisory_unlock(7015001)");
  } finally {
    await admin.end();
  }
  const url = new URL(t.url);
  url.username = APP_ROLE;
  url.password = APP_ROLE_PASSWORD;
  return createDb(url.toString(), { max: options.max ?? 5, scope: options.scope ?? "tenant" });
}
