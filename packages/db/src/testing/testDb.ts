// Test helper: a real PostgreSQL database per test file (no mocks). Each file gets a fresh, empty
// database that is migrated to latest, so every test run also proves "empty -> latest".
import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { createDb, type DbHandle } from "../client";
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
