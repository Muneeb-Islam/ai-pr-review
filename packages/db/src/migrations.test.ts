import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { RUN_STATUSES } from "@ai-pr-review/shared";
import { runMigrations } from "./migrate";
import { DEMO_GITHUB_INSTALLATION_ID, seedDemoData } from "./seed";
import {
  getFinding,
  listAgentRuns,
  listAuditLog,
  listFindings,
  listProviderCredentials,
  listRepositories,
  listRuns,
} from "./tenant";
import { getInstallationByGitHubId, listAccessibleInstallationIds } from "./system";
import { createTestDatabase, type TestDatabase } from "./testing/testDb";
import { RUN_TRIGGERS } from "@ai-pr-review/shared";

let t: TestDatabase;

beforeAll(async () => {
  // An empty database: nothing migrated yet.
  t = await createTestDatabase({ migrate: false });
}, 30_000);
afterAll(async () => {
  await t.drop();
});

const TABLES = [
  "users",
  "sessions",
  "installations",
  "user_installations",
  "repositories",
  "repo_settings",
  "provider_credentials",
  "webhook_deliveries",
  "review_runs",
  "agent_runs",
  "findings",
  "posted_comments",
  "finding_feedback",
  "audit_log",
];

async function query<T = Record<string, unknown>>(sql: string, params: unknown[] = []) {
  return (await t.pool.query(sql, params)).rows as T[];
}

describe("migrations", () => {
  it("start from an empty database", async () => {
    const tables = await query<{ table_name: string }>(
      "select table_name from information_schema.tables where table_schema = 'public'",
    );
    expect(tables).toEqual([]);
  });

  it("apply from empty to latest and create every table of design §5", async () => {
    await runMigrations(t.db);
    const rows = await query<{ table_name: string }>(
      "select table_name from information_schema.tables where table_schema = 'public'",
    );
    const names = rows.map((r) => r.table_name);
    for (const table of TABLES) expect(names).toContain(table);
  });

  it("are idempotent: applying again changes nothing", async () => {
    const before = await query("select id, hash from drizzle.__drizzle_migrations order by id");
    await runMigrations(t.db);
    expect(await query("select id, hash from drizzle.__drizzle_migrations order by id")).toEqual(
      before,
    );
  });

  it("use the column names of design §5", async () => {
    const columns = async (table: string) =>
      (
        await query<{ column_name: string }>(
          "select column_name from information_schema.columns where table_name = $1",
          [table],
        )
      ).map((r) => r.column_name);
    const expected: Record<string, string[]> = {
      users: ["id", "github_user_id", "login", "avatar_url", "created_at"],
      sessions: ["id", "user_id", "expires_at", "csrf_secret", "created_at"],
      installations: [
        "id",
        "github_installation_id",
        "account_login",
        "account_type",
        "status",
        "created_at",
      ],
      user_installations: ["user_id", "installation_id", "role", "refreshed_at"],
      repositories: [
        "id",
        "installation_id",
        "github_repo_id",
        "full_name",
        "default_branch",
        "is_private",
        "enabled",
        "active",
      ],
      repo_settings: ["repo_id", "config", "updated_by", "updated_at"],
      provider_credentials: [
        "id",
        "installation_id",
        "repo_id",
        "provider",
        "ciphertext",
        "key_version",
        "last4",
        "created_by",
        "created_at",
      ],
      webhook_deliveries: [
        "delivery_id",
        "event",
        "installation_id",
        "received_at",
        "processed_at",
        "outcome",
      ],
      review_runs: [
        "id",
        "repo_id",
        "pr_number",
        "head_sha",
        "base_sha",
        "base_ref",
        "trigger",
        "triggered_by",
        "status",
        "status_reason",
        "check_run_id",
        "summary_comment_id",
        "queued_at",
        "started_at",
        "finished_at",
        "parent_run_id",
        "warnings",
        "usage",
      ],
      agent_runs: [
        "id",
        "run_id",
        "agent",
        "status",
        "started_at",
        "duration_ms",
        "input_tokens",
        "output_tokens",
        "retries",
        "warnings",
      ],
      findings: [
        "id",
        "run_id",
        "repo_id",
        "agent",
        "category",
        "severity",
        "confidence",
        "title",
        "file_path",
        "start_line",
        "end_line",
        "evidence",
        "impact",
        "recommendation",
        "suggested_test",
        "fingerprint",
        "posted",
        "suppressed_reason",
      ],
      posted_comments: ["id", "run_id", "kind", "github_id", "fingerprint", "head_sha"],
      finding_feedback: ["finding_id", "user_id", "verdict", "note", "created_at"],
      audit_log: ["id", "installation_id", "user_id", "action", "target", "metadata", "at"],
    };
    // Every column of design §5 exists. The only additions are `installation_id` on the child tables
    // of review runs (and repo_settings), which design §5 requires of every tenant table.
    const addsInstallationId = new Set([
      "repo_settings",
      "review_runs",
      "agent_runs",
      "findings",
      "posted_comments",
      "finding_feedback",
    ]);
    for (const [table, wanted] of Object.entries(expected)) {
      const actual = await columns(table);
      expect(actual, table).toEqual(expect.arrayContaining(wanted));
      expect(
        actual.filter((c) => !wanted.includes(c)),
        table,
      ).toEqual(addsInstallationId.has(table) ? ["installation_id"] : []);
    }
  });

  it("create the indexes of design §5 and the partial index on active runs", async () => {
    const indexes = await query<{ indexname: string; indexdef: string }>(
      "select indexname, indexdef from pg_indexes where schemaname = 'public'",
    );
    const defs = indexes.map((i) => i.indexdef.replace(/\s+/g, " "));
    const has = (fragment: string) =>
      expect(
        defs.some((d) => d.includes(fragment)),
        fragment,
      ).toBe(true);

    has("ON public.review_runs USING btree (repo_id, queued_at DESC)");
    has("ON public.review_runs USING btree (status)");
    has("ON public.review_runs USING btree (repo_id, pr_number, head_sha)");
    has("ON public.findings USING btree (run_id)");
    has("ON public.findings USING btree (repo_id, severity)");
    has("ON public.webhook_deliveries USING btree (delivery_id)"); // the primary key's index

    const active = indexes.find((i) => i.indexname === "review_runs_active_idx");
    expect(active?.indexdef).toMatch(/WHERE .*status.*queued.*running/);
  });

  it("enforce the unique constraints of the phase", async () => {
    const unique = async (table: string, columns: string[]) => {
      const rows = await query<{ cols: string[] }>(
        `select array_agg(a.attname::text order by k.ord) as cols
           from pg_index i
           join pg_class c on c.oid = i.indrelid
           cross join lateral unnest(i.indkey) with ordinality as k(attnum, ord)
           join pg_attribute a on a.attrelid = c.oid and a.attnum = k.attnum
          where c.relname = $1 and i.indisunique and i.indpred is null
          group by i.indexrelid`,
        [table],
      );
      expect(
        rows.map((r) => r.cols),
        `${table}(${columns.join(",")})`,
      ).toContainEqual(columns);
    };
    await unique("webhook_deliveries", ["delivery_id"]);
    await unique("installations", ["github_installation_id"]);
    await unique("repositories", ["installation_id", "github_repo_id"]);
    await unique("users", ["github_user_id"]);
  });

  it("restrict enum-like columns to the values from packages/shared", async () => {
    const values = async (type: string) =>
      (
        await query<{ enumlabel: string }>(
          "select e.enumlabel from pg_enum e join pg_type t on t.oid = e.enumtypid where t.typname = $1 order by e.enumsortorder",
          [type],
        )
      ).map((r) => r.enumlabel);
    expect(await values("run_status")).toEqual([...RUN_STATUSES]);
    expect(await values("run_trigger")).toEqual([...RUN_TRIGGERS]);
    expect(await values("severity")).toEqual(["critical", "high", "medium", "low", "info"]);
    expect(await values("category")).toEqual([
      "bug",
      "security",
      "test_gap",
      "performance",
      "maintainability",
    ]);
    expect(await values("agent_id")).toEqual([
      "code_review",
      "test_coverage",
      "security",
      "final_review",
    ]);
    expect(await values("feedback_verdict")).toEqual(["useful", "false_positive", "known"]);
    expect(await values("installation_status")).toEqual(["active", "suspended", "deleted"]);
    await expect(
      t.pool.query(
        "insert into installations (github_installation_id, account_login, account_type, status) values (1, 'x', 'user', 'bogus')",
      ),
    ).rejects.toMatchObject({ code: "22P02" });
  });
});

describe("seed", () => {
  it("loads the demo installation, repositories, runs and findings", async () => {
    const summary = await seedDemoData(t.db);
    expect(summary).toMatchObject({ repositories: 3 });

    const installation = await getInstallationByGitHubId(t.db, DEMO_GITHUB_INSTALLATION_ID);
    expect(installation).toMatchObject({ accountLogin: "demo-org", status: "active" });
    const ids = [installation!.id];
    expect(await listAccessibleInstallationIds(t.db, summary.userId)).toEqual(ids);

    const repos = await listRepositories(t.db, ids);
    expect(repos.map((r) => r.fullName)).toEqual(["demo-org/api", "demo-org/docs", "demo-org/web"]);

    const all = [];
    let cursor: string | undefined;
    do {
      const page = await listRuns(t.db, ids, { limit: 100, ...(cursor ? { cursor } : {}) });
      all.push(...page.items);
      cursor = page.nextCursor ?? undefined;
    } while (cursor);
    expect(all).toHaveLength(summary.runs);
    // Every lifecycle state is represented, so the dashboard can be built against all of them.
    expect(new Set(all.map((r) => r.status))).toEqual(new Set(RUN_STATUSES));
    expect(all.some((r) => r.parentRunId)).toBe(true);

    const findings = await listFindings(t.db, ids, { includeSuppressed: true, limit: 100 });
    expect(findings.items).toHaveLength(summary.findings);
    expect(findings.items.some((f) => f.suppressedReason)).toBe(true);
    expect(await getFinding(t.db, ids, findings.items[0]!.id)).toBeDefined();
    expect(
      await listAgentRuns(t.db, ids, all.find((r) => r.status === "completed")!.id),
    ).not.toHaveLength(0);
    expect(await listProviderCredentials(t.db, ids)).toHaveLength(1);
    expect((await listAuditLog(t.db, ids)).items).toHaveLength(2);
  });

  it("can be loaded again, replacing the previous demo data", async () => {
    const before = await seedDemoData(t.db);
    const again = await seedDemoData(t.db);
    expect(again.runs).toBe(before.runs);
    const { rows } = await t.pool.query("select count(*)::int as n from installations");
    expect(rows[0].n).toBe(1);
  });
});
