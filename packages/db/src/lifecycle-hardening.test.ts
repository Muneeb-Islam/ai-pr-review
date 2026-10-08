// Phase 15 data lifecycle in the database: uninstall and suspend (stop runs, drop keys and access), the purge at the
// end of retention, the bookkeeping tables' own retention, the queue depth and the operator's numbers.
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { evaluateQueueDepth } from "@ai-pr-review/shared";
import {
  appendAuditLog,
  getRun,
  listAuditLog,
  listFindings,
  listProviderCredentials,
  listRepositories,
  putProviderCredential,
  transitionRun,
  upsertInstallationSettings,
} from "./tenant";
import {
  cancelActiveRunsOfInstallation,
  deleteAuditOlderThan,
  deleteInstallationAccess,
  deleteInstallationCredentials,
  deleteStaleAccessCache,
  deleteWebhookDeliveriesOlderThan,
  getOperationalStats,
  getQueueDepth,
  getRunById,
  listAccessibleInstallationIds,
  markWebhookDeliveryProcessed,
  purgeDeletedInstallations,
  recordWebhookDelivery,
  replaceUserInstallations,
  setInstallationStatus,
  upsertInstallationFromGitHub,
} from "./system";
import {
  createTenant,
  createTestDatabase,
  makeFullRun,
  makeRun,
  makeRunInStatus,
  type Tenant,
  type TestDatabase,
} from "./testing";

const DAY = 24 * 60 * 60 * 1000;
let t: TestDatabase;

beforeAll(async () => {
  t = await createTestDatabase();
}, 60_000);
afterAll(async () => {
  await t.drop();
});

const rowCount = async (table: string, where = "true"): Promise<number> =>
  (await t.pool.query(`select count(*)::int as n from ${table} where ${where}`)).rows[0].n;

/** Moves an installation's status clock into the past, as if it changed `days` ago. */
const backdate = (installationId: string, days: number) =>
  t.db.execute(
    sql`update installations set status_changed_at = now() - make_interval(days => ${days}) where id = ${installationId}`,
  );

describe("status_changed_at", () => {
  it("moves when the status changes and stays when the same status is reported again", async () => {
    const tenant = await createTenant(t.db, "clock");
    const gh = tenant.installation.githubInstallationId;
    await backdate(tenant.installation.id, 30);
    const before = (
      await t.pool.query("select status_changed_at from installations where id = $1", [
        tenant.installation.id,
      ])
    ).rows[0].status_changed_at as Date;

    await setInstallationStatus(t.db, gh, "active"); // unchanged
    const same = (
      await t.pool.query("select status_changed_at from installations where id = $1", [
        tenant.installation.id,
      ])
    ).rows[0].status_changed_at as Date;
    expect(same.getTime()).toBe(before.getTime());

    await setInstallationStatus(t.db, gh, "suspended");
    const moved = (
      await t.pool.query("select status_changed_at from installations where id = $1", [
        tenant.installation.id,
      ])
    ).rows[0].status_changed_at as Date;
    expect(moved.getTime()).toBeGreaterThan(before.getTime() + 29 * DAY);

    // The same through a repeated "created" event.
    await backdate(tenant.installation.id, 10);
    await upsertInstallationFromGitHub(t.db, {
      githubInstallationId: gh,
      accountLogin: tenant.installation.accountLogin,
      accountType: "organization",
      status: "suspended",
    });
    const repeated = (
      await t.pool.query("select status_changed_at from installations where id = $1", [
        tenant.installation.id,
      ])
    ).rows[0].status_changed_at as Date;
    expect(Date.now() - repeated.getTime()).toBeGreaterThan(9 * DAY);
  });
});

describe("cancelActiveRunsOfInstallation", () => {
  it("cancels queued and running runs of that installation only, with the reason, and leaves finished ones", async () => {
    const a = await createTenant(t.db, "stop-a");
    const b = await createTenant(t.db, "stop-b");
    const queued = await makeRun(t.db, a);
    const running = await makeRunInStatus(t.db, a, "running");
    const done = await makeRunInStatus(t.db, a, "completed");
    const others = await makeRun(t.db, b);

    const stopped = await cancelActiveRunsOfInstallation(
      t.db,
      a.installation.id,
      "The App was uninstalled.",
    );

    expect(stopped.map((r) => r.id).sort()).toEqual([queued.id, running.id].sort());
    for (const id of [queued.id, running.id]) {
      const run = (await getRunById(t.db, id))!;
      expect(run).toMatchObject({ status: "cancelled", statusReason: "The App was uninstalled." });
      expect(run.finishedAt).toBeInstanceOf(Date);
    }
    expect((await getRunById(t.db, done.id))!.status).toBe("completed");
    expect((await getRunById(t.db, others.id))!.status).toBe("queued");
    // A worker that still holds the run loses its fence: the claim needs `running`.
    await expect(transitionRun(t.db, a.installation.id, running.id, "completed")).rejects.toThrow();
  });

  it("does nothing for a malformed id", async () => {
    expect(await cancelActiveRunsOfInstallation(t.db, "nope", "x")).toEqual([]);
  });
});

describe("credentials and access of an uninstalled installation", () => {
  it("deletes every stored key of the installation and no one else's", async () => {
    const a = await createTenant(t.db, "keys-a");
    const b = await createTenant(t.db, "keys-b");
    const put = (tenant: Tenant, provider: "deepseek" | "openai") =>
      putProviderCredential(t.db, tenant.installation.id, {
        provider,
        ciphertext: Buffer.from("x"),
        keyVersion: 1,
        last4: "abcd",
      });
    await put(a, "deepseek");
    await put(a, "openai");
    await put(b, "deepseek");

    expect(await deleteInstallationCredentials(t.db, a.installation.id)).toBe(2);
    expect(await listProviderCredentials(t.db, [a.installation.id])).toEqual([]);
    expect(await listProviderCredentials(t.db, [b.installation.id])).toHaveLength(1);
  });

  it("removes who may see the installation, so no session keeps access", async () => {
    const a = await createTenant(t.db, "access-a");
    await replaceUserInstallations(t.db, a.user.id, [
      { installationId: a.installation.id, role: "admin" },
    ]);
    expect(await listAccessibleInstallationIds(t.db, a.user.id)).toEqual([a.installation.id]);
    expect(await deleteInstallationAccess(t.db, a.installation.id)).toBeGreaterThanOrEqual(1);
    expect(await listAccessibleInstallationIds(t.db, a.user.id)).toEqual([]);
  });
});

describe("purgeDeletedInstallations (AC-22, PL-08)", () => {
  it("deletes an installation uninstalled longer ago than the window, with everything it owns", async () => {
    const gone = await createTenant(t.db, "purge-gone");
    const full = await makeFullRun(t.db, gone);
    await appendAuditLog(t.db, gone.installation.id, { action: "settings.update", target: "x" });
    await upsertInstallationSettings(t.db, gone.installation.id, { provider: "deepseek" });
    await setInstallationStatus(t.db, gone.installation.githubInstallationId, "deleted");
    await backdate(gone.installation.id, 91);

    const recent = await createTenant(t.db, "purge-recent");
    await makeFullRun(t.db, recent);
    await setInstallationStatus(t.db, recent.installation.githubInstallationId, "deleted");
    await backdate(recent.installation.id, 10);

    const suspended = await createTenant(t.db, "purge-suspended");
    await makeFullRun(t.db, suspended);
    await setInstallationStatus(t.db, suspended.installation.githubInstallationId, "suspended");
    await backdate(suspended.installation.id, 400);

    const active = await createTenant(t.db, "purge-active");
    await makeFullRun(t.db, active);
    await backdate(active.installation.id, 400);

    const purged = await purgeDeletedInstallations(t.db, 90);

    expect(purged).toBe(1);
    const owned = `installation_id = '${gone.installation.id}'`;
    for (const table of [
      "repositories",
      "review_runs",
      "agent_runs",
      "findings",
      "posted_comments",
      "finding_feedback",
      "audit_log",
      "installation_settings",
    ]) {
      expect(await rowCount(table, owned), table).toBe(0);
    }
    expect(await rowCount("installations", `id = '${gone.installation.id}'`)).toBe(0);
    expect(await getRun(t.db, [gone.installation.id], full.run.id)).toBeUndefined();
    // The others are untouched.
    for (const keep of [recent, suspended, active]) {
      expect(await rowCount("installations", `id = '${keep.installation.id}'`)).toBe(1);
      expect((await listFindings(t.db, [keep.installation.id])).items.length).toBeGreaterThan(0);
      expect(await listRepositories(t.db, [keep.installation.id])).toHaveLength(2);
    }
    // And it is idempotent.
    expect(await purgeDeletedInstallations(t.db, 90)).toBe(0);
  });

  it("rejects a window that is not a positive number", async () => {
    await expect(purgeDeletedInstallations(t.db, 0)).rejects.toThrow("positive");
    await expect(purgeDeletedInstallations(t.db, Number.NaN)).rejects.toThrow("positive");
  });
});

describe("bookkeeping retention", () => {
  it("deletes audit entries older than the window and keeps newer ones", async () => {
    const tenant = await createTenant(t.db, "audit");
    const now = new Date("2032-06-15T12:00:00.000Z");
    await appendAuditLog(t.db, tenant.installation.id, {
      action: "old",
      target: "x",
      at: new Date(now.getTime() - 400 * DAY),
    });
    await appendAuditLog(t.db, tenant.installation.id, {
      action: "new",
      target: "x",
      at: new Date(now.getTime() - 5 * DAY),
    });
    const deleted = await deleteAuditOlderThan(t.db, 365, now);
    expect(deleted).toBeGreaterThanOrEqual(1);
    const left = (await listAuditLog(t.db, [tenant.installation.id])).items.map((e) => e.action);
    expect(left).toEqual(["new"]);
  });

  it("deletes webhook delivery records older than the window", async () => {
    await recordWebhookDelivery(t.db, { deliveryId: "old-delivery", event: "ping" });
    await recordWebhookDelivery(t.db, { deliveryId: "new-delivery", event: "ping" });
    await t.pool.query(
      "update webhook_deliveries set received_at = now() - interval '30 days' where delivery_id = 'old-delivery'",
    );
    expect(await deleteWebhookDeliveriesOlderThan(t.db, 14)).toBeGreaterThanOrEqual(1);
    expect(await rowCount("webhook_deliveries", "delivery_id = 'old-delivery'")).toBe(0);
    expect(await rowCount("webhook_deliveries", "delivery_id = 'new-delivery'")).toBe(1);
  });

  it("drops cached access that was not refreshed since the cut-off", async () => {
    const tenant = await createTenant(t.db, "stale");
    await replaceUserInstallations(t.db, tenant.user.id, [
      { installationId: tenant.installation.id, role: "viewer" },
    ]);
    await t.pool.query(
      "update user_installations set refreshed_at = now() - interval '40 days' where user_id = $1",
      [tenant.user.id],
    );
    expect(
      await deleteStaleAccessCache(t.db, new Date(Date.now() - 30 * DAY)),
    ).toBeGreaterThanOrEqual(1);
    expect(await listAccessibleInstallationIds(t.db, tenant.user.id)).toEqual([]);
  });
});

describe("queue depth and the operator's numbers", () => {
  it("counts queued runs for one installation and for everyone, and the limits read it", async () => {
    const a = await createTenant(t.db, "depth-a");
    const b = await createTenant(t.db, "depth-b");
    const before = await getQueueDepth(t.db, a.installation.id);
    await makeRun(t.db, a);
    await makeRun(t.db, a);
    await makeRun(t.db, b);
    await makeRunInStatus(t.db, a, "running"); // not waiting any more

    const after = await getQueueDepth(t.db, a.installation.id);
    expect(after.installation - before.installation).toBe(2);
    expect(after.global - before.global).toBe(3);
    expect(await getQueueDepth(t.db, "garbage")).toMatchObject({ installation: 0 });

    expect(
      evaluateQueueDepth({ installation: 2, global: 3 }, { perInstallation: 2, global: 100 }),
    ).toMatchObject({
      allowed: false,
    });
    expect(
      evaluateQueueDepth({ installation: 1, global: 100 }, { perInstallation: 2, global: 100 }),
    ).toMatchObject({
      allowed: false,
    });
    expect(
      evaluateQueueDepth({ installation: 1, global: 99 }, { perInstallation: 2, global: 100 }),
    ).toEqual({
      allowed: true,
    });
  });
});

describe("getOperationalStats", () => {
  it("reports the queue, durations, failures and webhook health from the rows (hand-computed)", async () => {
    const db = await createTestDatabase();
    try {
      const tenant = await createTenant(db.db, "stats");
      const now = new Date("2033-01-10T12:00:00.000Z");
      const at = (minutesAgo: number) => new Date(now.getTime() - minutesAgo * 60_000);

      // Two queued runs, the older waited 30 minutes; one running with a fresh heartbeat, one without.
      await makeRun(db.db, tenant, { at: at(30) });
      await makeRun(db.db, tenant, { at: at(5) });
      const fresh = await makeRunInStatus(db.db, tenant, "running", { at: at(20) });
      const dead = await makeRunInStatus(db.db, tenant, "running", { at: at(20) });
      await db.pool.query("update review_runs set heartbeat_at = $2 where id = $1", [
        fresh.id,
        at(1),
      ]);
      await db.pool.query("update review_runs set heartbeat_at = $2 where id = $1", [
        dead.id,
        at(10),
      ]);

      // Finished runs in the window: durations 60, 120, 300 s (completed, partial, completed) and one failed.
      const finish = async (status: "completed" | "partial" | "failed", seconds: number) => {
        const run = await makeRunInStatus(db.db, tenant, "running", { at: at(100) });
        const started = at(90);
        await db.pool.query(
          "update review_runs set status = $2, started_at = $3, finished_at = $4, usage = $5 where id = $1",
          [
            run.id,
            status,
            started,
            new Date(started.getTime() + seconds * 1000),
            JSON.stringify({ inputTokens: 1000, outputTokens: 100 }),
          ],
        );
      };
      await finish("completed", 60);
      await finish("partial", 120);
      await finish("completed", 300);
      await finish("failed", 10);

      // Webhooks: three received in the window (one failed, one never finished), one older than the window.
      await recordWebhookDelivery(db.db, { deliveryId: "w1", event: "pull_request" });
      await markWebhookDeliveryProcessed(db.db, "w1", "run_queued");
      await recordWebhookDelivery(db.db, { deliveryId: "w2", event: "pull_request" });
      await markWebhookDeliveryProcessed(db.db, "w2", "error");
      await recordWebhookDelivery(db.db, { deliveryId: "w3", event: "pull_request" });
      await recordWebhookDelivery(db.db, { deliveryId: "w4", event: "pull_request" });
      await db.pool.query(
        "update webhook_deliveries set received_at = $1 where delivery_id in ('w1','w2','w3')",
        [at(60)],
      );
      await db.pool.query(
        "update webhook_deliveries set received_at = $1 where delivery_id = 'w4'",
        [new Date(now.getTime() - 3 * 86_400_000)],
      );
      await setInstallationStatus(db.db, tenant.installation.githubInstallationId, "suspended");

      const stats = await getOperationalStats(db.db, { now, staleAfterSeconds: 120 });

      // Finished runs have finished_at = 90 minutes ago + duration, inside the 24 h window.
      expect(stats.active).toEqual({ queued: 2, running: 2 });
      expect(stats.oldestQueuedAgeSeconds).toBeCloseTo(30 * 60, 0);
      expect(stats.stuckRunning).toBe(1);
      expect(stats.finished).toEqual({ completed: 2, partial: 1, failed: 1 });
      expect(stats.durationSeconds.count).toBe(3);
      expect(stats.durationSeconds.p50).toBeCloseTo(120, 5);
      expect(stats.durationSeconds.sum).toBeCloseTo(480, 5);
      expect(stats.durationSeconds.p95).toBeCloseTo(282, 5); // 120 + 0.9 * (300 - 120)
      expect(stats.webhooks).toEqual({ received: 3, failed: 1, unprocessed: 1 });
      expect(stats.installations).toEqual({ active: 0, suspended: 1, deleted: 0 });
      expect(stats.tokens).toEqual({ input: 4000, output: 400 });
    } finally {
      await db.drop();
    }
  });
});
