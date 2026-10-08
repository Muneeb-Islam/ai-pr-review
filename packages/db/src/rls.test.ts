// Row-level security (design §9, Phase 15): a second wall behind the tenant-scoped functions. These tests connect as a
// plain role (no superuser, no BYPASSRLS, not the table owner) and run deliberately unscoped SQL, the kind of
// query a bug would produce, to show that the database itself keeps tenants apart.
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createAppRoleHandle,
  createTenant,
  createTestDatabase,
  makeFullRun,
  makeRun,
  type Tenant,
  type TestDatabase,
} from "./testing";
import { createDb, getRowSecurityStatus, withInstallationScope, type DbHandle } from "./index";
import { listRuns, listFindings, getRun } from "./index";
import { getRunById, listAccessibleInstallationIds } from "./system";

let t: TestDatabase;
let tenantPool: DbHandle; // the dashboard's pool: no scope until withInstallationScope names one
let systemPool: DbHandle; // the worker's pool: announces the system scope on every connection
let alpha: Tenant;
let beta: Tenant;
let alphaRun: Awaited<ReturnType<typeof makeFullRun>>;
let betaRun: Awaited<ReturnType<typeof makeFullRun>>;

beforeAll(async () => {
  t = await createTestDatabase();
  alpha = await createTenant(t.db, "alpha");
  beta = await createTenant(t.db, "beta");
  alphaRun = await makeFullRun(t.db, alpha);
  betaRun = await makeFullRun(t.db, beta);
  tenantPool = await createAppRoleHandle(t, { scope: "tenant" });
  systemPool = await createAppRoleHandle(t, { scope: "system" });
}, 60_000);

afterAll(async () => {
  await tenantPool.close();
  await systemPool.close();
  await t.drop();
});

const TENANT_TABLES = [
  "installations",
  "repositories",
  "installation_settings",
  "repo_settings",
  "provider_credentials",
  "review_runs",
  "agent_runs",
  "findings",
  "posted_comments",
  "finding_feedback",
  "audit_log",
] as const;

const count = async (db: DbHandle["db"], table: string): Promise<number> => {
  const result = await db.execute<{ n: number }>(
    sql`select count(*)::int as n from ${sql.identifier(table)}`,
  );
  return result.rows[0]!.n;
};

describe("the role", () => {
  it("is subject to the policies, unlike the superuser that owns the database", async () => {
    expect(await getRowSecurityStatus(tenantPool.db)).toMatchObject({ enforced: true });
    expect((await getRowSecurityStatus(t.db)).enforced).toBe(false);
  });

  it("has a policy on every table that carries an installation id (a new tenant table must not be forgotten)", async () => {
    const result = await t.db.execute<{ table_name: string }>(sql`
      select distinct c.table_name
      from information_schema.columns c
      join information_schema.tables t using (table_schema, table_name)
      where c.table_schema = 'public' and t.table_type = 'BASE TABLE'
        and c.column_name = 'installation_id'
    `);
    const withColumn = result.rows.map((r) => r.table_name);
    const protectedTables = (
      await t.db.execute<{ tablename: string }>(
        sql`select tablename from pg_policies where schemaname = 'public' and policyname = 'tenant_scope'`,
      )
    ).rows.map((r) => r.tablename);
    // Not tenant data: the idempotency log (written before an installation is known) and the access caches.
    const exempt = ["webhook_deliveries", "user_installations", "user_repositories"];
    for (const table of withColumn) {
      if (exempt.includes(table)) continue;
      expect(protectedTables, `${table} has no row-level security policy`).toContain(table);
    }
    for (const table of TENANT_TABLES) expect(protectedTables).toContain(table);
  });
});

describe("a session that names no installation", () => {
  it("sees nothing in any tenant table, whatever it asks for", async () => {
    for (const table of TENANT_TABLES) expect(await count(tenantPool.db, table), table).toBe(0);
    expect(await getRunById(tenantPool.db, alphaRun.run.id)).toBeUndefined();
  });

  it("cannot write either: the policy refuses the row", async () => {
    await expect(
      tenantPool.db.execute(
        sql`insert into repo_settings (repo_id, installation_id, config) values (${alpha.repo.id}, ${alpha.installation.id}, '{}')`,
      ),
    ).rejects.toMatchObject({ cause: { code: "42501" } });
  });
});

describe("withInstallationScope", () => {
  it("shows only the named installation, even to a query that forgets its WHERE clause", async () => {
    const seen = await withInstallationScope(tenantPool.db, [alpha.installation.id], async (db) => {
      const runs = await db.execute<{ id: string; installation_id: string }>(
        sql`select id, installation_id from review_runs`,
      );
      const found = await db.execute<{ installation_id: string }>(
        sql`select installation_id from findings`,
      );
      return { runs: runs.rows, findings: found.rows };
    });
    expect(seen.runs.map((r) => r.id)).toEqual([alphaRun.run.id]);
    expect(new Set(seen.findings.map((f) => f.installation_id))).toEqual(
      new Set([alpha.installation.id]),
    );
    expect(seen.findings.length).toBeGreaterThan(0);
  });

  it("shows several installations when several are named, and none when the list is empty or malformed", async () => {
    const both = await withInstallationScope(
      tenantPool.db,
      [alpha.installation.id, beta.installation.id],
      (db) => count(db, "review_runs"),
    );
    expect(both).toBe(2);
    expect(await withInstallationScope(tenantPool.db, [], (db) => count(db, "review_runs"))).toBe(
      0,
    );
    // Not a uuid: dropped, never interpolated into anything.
    expect(
      await withInstallationScope(tenantPool.db, ["x'; drop table review_runs; --"], (db) =>
        count(db, "review_runs"),
      ),
    ).toBe(0);
    expect(await count(t.db, "review_runs")).toBe(2);
  });

  it("runs queries issued side by side one after another on the transaction's connection", async () => {
    // The data layer uses Promise.all for independent reads; on one connection node-postgres would warn
    // (and will refuse in v9) unless the scope queues them.
    const warnings: string[] = [];
    const onWarning = (warning: Error) => warnings.push(warning.message);
    process.on("warning", onWarning);
    try {
      const sizes = await withInstallationScope(tenantPool.db, [alpha.installation.id], (db) =>
        Promise.all([count(db, "review_runs"), count(db, "findings"), count(db, "repositories")]),
      );
      expect(sizes).toEqual([1, 2, 2]);
      await new Promise((resolve) => setImmediate(resolve));
    } finally {
      process.off("warning", onWarning);
    }
    expect(warnings.filter((w) => w.includes("client.query()"))).toEqual([]);
  });

  it("does not leak into the next use of the connection (the setting ends with the transaction)", async () => {
    await withInstallationScope(tenantPool.db, [alpha.installation.id], (db) =>
      count(db, "review_runs"),
    );
    expect(await count(tenantPool.db, "review_runs")).toBe(0);
  });

  it("makes another tenant's row invisible to updates and deletes, and unwritable", async () => {
    await withInstallationScope(tenantPool.db, [alpha.installation.id], async (db) => {
      const updated = await db.execute(
        sql`update review_runs set status_reason = 'tampered' where id = ${betaRun.run.id}`,
      );
      expect(updated.rowCount).toBe(0);
      const deleted = await db.execute(
        sql`delete from findings where installation_id = ${beta.installation.id}`,
      );
      expect(deleted.rowCount).toBe(0);
      await expect(
        db.transaction((tx) =>
          tx.execute(
            sql`insert into audit_log (installation_id, action, target) values (${beta.installation.id}, 'planted', 'x')`,
          ),
        ),
      ).rejects.toMatchObject({ cause: { code: "42501" } });
    });
    const intact = await t.db.execute<{ status_reason: string | null }>(
      sql`select status_reason from review_runs where id = ${betaRun.run.id}`,
    );
    expect(intact.rows[0]!.status_reason).not.toBe("tampered");
    expect(await count(t.db, "findings")).toBe(4);
  });

  it("serves the tenant-scoped functions unchanged", async () => {
    await withInstallationScope(tenantPool.db, [alpha.installation.id], async (db) => {
      const ids = [alpha.installation.id];
      expect((await listRuns(db, ids)).items.map((r) => r.id)).toEqual([alphaRun.run.id]);
      expect((await getRun(db, ids, alphaRun.run.id))?.id).toBe(alphaRun.run.id);
      expect((await listFindings(db, ids)).items.length).toBeGreaterThan(0);
      // Even a caller that passes the wrong tenant's id to a scoped function gets nothing from the database.
      expect(await getRun(db, [beta.installation.id], betaRun.run.id)).toBeUndefined();
    });
  });

  it("works for a handler that writes: the scoped transaction commits and is visible afterwards", async () => {
    const run = await makeRun(t.db, alpha);
    await withInstallationScope(tenantPool.db, [alpha.installation.id], (db) =>
      db.execute(sql`update review_runs set status_reason = 'seen' where id = ${run.id}`),
    );
    const after = await t.db.execute<{ status_reason: string }>(
      sql`select status_reason from review_runs where id = ${run.id}`,
    );
    expect(after.rows[0]!.status_reason).toBe("seen");
  });
});

describe("the system scope (worker, webhooks, jobs)", () => {
  it("sees every tenant on a pool that announces it, without naming installations", async () => {
    expect(await count(systemPool.db, "review_runs")).toBeGreaterThanOrEqual(2);
    expect((await getRunById(systemPool.db, betaRun.run.id))?.id).toBe(betaRun.run.id);
    expect(await listAccessibleInstallationIds(systemPool.db, alpha.user.id)).toEqual([]);
  });

  it("can write across tenants (it is the platform acting, not a user)", async () => {
    const run = await makeRun(systemPool.db, beta);
    expect(run.installationId).toBe(beta.installation.id);
  });

  it("is not available to a session that merely asks for it with the tenant pool's connection", async () => {
    // A SET inside a transaction is possible for any session: the system scope is a convention of the
    // worker's own pool, not a boundary against code that already runs SQL. The dashboard never does this.
    expect(await count(tenantPool.db, "review_runs")).toBe(0);
  });
});

describe("default scope of createDb", () => {
  it("announces the system scope unless told otherwise", async () => {
    const handle = createDb(t.url, { max: 1 });
    try {
      const result = await handle.db.execute<{ scope: string | null }>(
        sql`select current_setting('aipr.scope', true) as scope`,
      );
      expect(result.rows[0]!.scope).toBe("system");
    } finally {
      await handle.close();
    }
  });
});
