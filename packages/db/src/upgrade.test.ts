// Upgrading a database that already holds data (Phase 16, "migrations tested from the previous schema"): for every
// earlier schema version, build a database at that version, put a tenant's history in it, apply the migrations
// that came after, and check the history is still there and the result is the schema a fresh install gets.
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { MIGRATIONS_FOLDER, runMigrations } from "./migrate";
import { createTestDatabase, type TestDatabase } from "./testing/testDb";

interface Journal {
  entries: Array<{ tag: string }>;
}
const journal: Journal = JSON.parse(
  readFileSync(join(MIGRATIONS_FOLDER, "meta/_journal.json"), "utf8"),
);

/** A copy of the migrations folder that stops after the first `count` migrations. */
function truncatedMigrations(count: number): string {
  const dir = mkdtempSync(join(tmpdir(), "aipr-migrations-"));
  cpSync(MIGRATIONS_FOLDER, dir, { recursive: true });
  writeFileSync(
    join(dir, "meta/_journal.json"),
    JSON.stringify({ ...journal, entries: journal.entries.slice(0, count) }),
  );
  return dir;
}

// The schema a fresh install gets: created once, compared with every upgraded database.
let fresh: TestDatabase;
beforeAll(async () => {
  fresh = await createTestDatabase();
}, 60_000);
afterAll(async () => {
  await fresh.drop();
}, 60_000);

/** The columns of every table, in a form two databases can be compared by. */
async function shape(t: TestDatabase): Promise<string[]> {
  const { rows } = await t.pool.query<{ line: string }>(
    `select table_name || '.' || column_name || ' ' || data_type || ' ' || is_nullable as line
       from information_schema.columns where table_schema = 'public' order by 1`,
  );
  return rows.map((r) => r.line);
}

/** One tenant's history, written with only the columns that have existed since the first migration. */
async function insertHistory(t: TestDatabase): Promise<void> {
  const q = (text: string, params: unknown[] = []) => t.pool.query(text, params);
  const inst = (
    await q(
      `insert into installations (github_installation_id, account_login, account_type) values (9001, 'legacy-org', 'organization') returning id`,
    )
  ).rows[0].id;
  const repo = (
    await q(
      `insert into repositories (installation_id, github_repo_id, full_name, default_branch, is_private) values ($1, 9101, 'legacy-org/app', 'main', true) returning id`,
      [inst],
    )
  ).rows[0].id;
  const run = async (pr: number, status: string, parent: string | null) =>
    (
      await q(
        `insert into review_runs (installation_id, repo_id, pr_number, head_sha, base_sha, base_ref, trigger, status, parent_run_id, started_at, finished_at)
         values ($1, $2, $3, $4, $5, 'main', 'pull_request', $6, $7, now(), now()) returning id`,
        [inst, repo, pr, "a".repeat(40), "b".repeat(40), status, parent],
      )
    ).rows[0].id as string;
  const first = await run(5, "completed", null);
  await run(5, "completed", first);
  await q(
    `insert into agent_runs (installation_id, run_id, agent, status, input_tokens, output_tokens) values ($1, $2, 'code_review', 'ok', 1200, 300)`,
    [inst, first],
  );
  await q(
    `insert into findings (installation_id, run_id, repo_id, agent, category, severity, confidence, title, evidence, impact, recommendation, fingerprint, posted)
     values ($1, $2, $3, 'code_review', 'bug', 'high', 0.9, 'Legacy finding', 'x', 'It breaks.', 'Fix it.', $4, true)`,
    [inst, first, repo, "f".repeat(16)],
  );
}

describe("upgrading a database that holds data", () => {
  // Every schema version before the latest: the database as it was after migration `from`.
  for (let from = 1; from < journal.entries.length; from++) {
    it(`from the schema after ${journal.entries[from - 1]!.tag}: the history survives and the schema matches a fresh install`, async () => {
      const old = await createTestDatabase({ migrate: false });
      const folder = truncatedMigrations(from);
      try {
        await runMigrations(old.db, folder);
        await insertHistory(old);

        await runMigrations(old.db);

        const count = async (table: string, where = "true") =>
          Number(
            (await old.pool.query(`select count(*) as n from ${table} where ${where}`)).rows[0].n,
          );
        expect(
          await count("installations", "account_login = 'legacy-org' and status = 'active'"),
        ).toBe(1);
        expect(await count("repositories")).toBe(1);
        expect(await count("review_runs", "status = 'completed'")).toBe(2);
        expect(await count("review_runs", "parent_run_id is not null")).toBe(1);
        expect(await count("agent_runs", "input_tokens = 1200")).toBe(1);
        expect(await count("findings", "title = 'Legacy finding' and posted")).toBe(1);

        expect(await shape(old)).toEqual(await shape(fresh));
        const applied = (t: TestDatabase) =>
          t.pool.query("select count(*) as n from drizzle.__drizzle_migrations");
        expect((await applied(old)).rows[0].n).toBe((await applied(fresh)).rows[0].n);
      } finally {
        await old.drop();
        rmSync(folder, { recursive: true, force: true });
      }
    }, 60_000);
  }

  it("has a snapshot for every migration, so `db:generate` starts from the real schema", () => {
    for (const entry of journal.entries) {
      const index = entry.tag.slice(0, 4);
      expect(() =>
        readFileSync(join(MIGRATIONS_FOLDER, `meta/${index}_snapshot.json`), "utf8"),
      ).not.toThrow();
    }
  });
});
