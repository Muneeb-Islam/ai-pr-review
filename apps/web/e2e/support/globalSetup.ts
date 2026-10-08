// Before the browser tests: migrate and seed the database, and sign the demo user in by creating a session row
// and the signed cookie the api expects (the same format as apps/api/src/auth/sessions.ts).
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { createDb, listRepositories, runMigrations, type Database } from "@ai-pr-review/db";
import { createSession } from "@ai-pr-review/db/system";
import { seedDemoData } from "@ai-pr-review/db/seed";
import { sign } from "../../../api/src/auth/signing";
import pg from "pg";
import {
  AUTH_FILE,
  e2eDatabaseUrl,
  requireEnv,
  SESSION_SECRET,
  SIGNOUT_AUTH_FILE,
  STATE_FILE,
  WEB_URL,
} from "./env";

export interface SeedState {
  installationId: string;
  userId: string;
  repos: Record<"api" | "web" | "docs", string>;
}

/** Creates a session row and writes the browser state (the cookie) that goes with it. */
async function writeSession(db: Database, userId: string, file: string): Promise<void> {
  const session = await createSession(db, {
    userId,
    csrfSecret: `e2e-csrf-${file}`,
    expiresAt: new Date(Date.now() + 24 * 3_600_000),
  });
  // Playwright's storage-state format: the cookie the browser would hold after signing in.
  writeFileSync(
    file,
    JSON.stringify({
      cookies: [
        {
          name: "aipr_session",
          value: sign(SESSION_SECRET, "session", session.id),
          domain: new URL(WEB_URL).hostname,
          path: "/",
          httpOnly: true,
          secure: false,
          sameSite: "Lax",
          expires: Math.floor(Date.now() / 1000) + 24 * 3600,
        },
      ],
      origins: [],
    }),
  );
}

/** Creates the test database next to the configured one if it does not exist yet. */
async function ensureDatabase(): Promise<void> {
  const target = new URL(e2eDatabaseUrl());
  const name = decodeURIComponent(target.pathname.slice(1));
  const admin = new pg.Client({ connectionString: requireEnv("DATABASE_URL") });
  await admin.connect();
  try {
    const found = await admin.query("select 1 from pg_database where datname = $1", [name]);
    // CREATE DATABASE cannot take a parameter; the name is ours (or an explicit override), quoted as an identifier.
    if (found.rowCount === 0) await admin.query(`create database "${name.replaceAll('"', '""')}"`);
  } finally {
    await admin.end();
  }
}

export default async function globalSetup(): Promise<void> {
  await ensureDatabase();
  const handle = createDb(e2eDatabaseUrl(), { max: 2 });
  try {
    await runMigrations(handle.db);
    const seeded = await seedDemoData(handle.db);

    const repos = await listRepositories(handle.db, [seeded.installationId]);
    const idOf = (name: string) => repos.find((r) => r.fullName === `demo-org/${name}`)!.id;
    const state: SeedState = {
      installationId: seeded.installationId,
      userId: seeded.userId,
      repos: { api: idOf("api"), web: idOf("web"), docs: idOf("docs") },
    };

    mkdirSync(dirname(STATE_FILE), { recursive: true });
    writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
    await writeSession(handle.db, seeded.userId, AUTH_FILE);
    await writeSession(handle.db, seeded.userId, SIGNOUT_AUTH_FILE);
  } finally {
    await handle.close();
  }
}
