// The scheduled retention cleanup (PL-08, AC-20) against a real PostgreSQL: old finished runs go with their
// findings, comments and feedback; recent and active runs stay.
import {
  createTenant,
  createTestDatabase,
  makeFullRun,
  makeRun,
  type Tenant,
  type TestDatabase,
} from "@ai-pr-review/db/testing";
import { appendAuditLog, getRun, listFindings } from "@ai-pr-review/db";
import { recordWebhookDelivery, replaceUserInstallations } from "@ai-pr-review/db/system";
import { createLogger } from "@ai-pr-review/shared";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { RetentionJob } from "./retention";

const DAY = 86_400_000;
const NOW = new Date("2032-06-15T12:00:00.000Z");
const ago = (days: number) => new Date(NOW.getTime() - days * DAY);

let t: TestDatabase;
let tenant: Tenant;
const lines: string[] = [];
const logger = createLogger({}, (line) => lines.push(line));

beforeAll(async () => {
  t = await createTestDatabase();
  tenant = await createTenant(t.db, "retain");
}, 30_000);
afterAll(async () => {
  await t.drop();
});
afterEach(() => {
  vi.useRealTimers();
  lines.length = 0;
});

const job = (days = 90) => new RetentionJob({ db: t.db, logger, days, now: () => NOW });
const ids = () => [tenant.installation.id];

describe("RetentionJob", () => {
  it("deletes finished runs older than the window with their findings, and keeps the rest", async () => {
    const old = await makeFullRun(t.db, tenant, { at: ago(120) });
    const recent = await makeFullRun(t.db, tenant, { at: ago(10) });
    const oldActive = await makeRun(t.db, tenant, { at: ago(200) });

    expect(await job().runOnce()).toBe(1);

    expect(await getRun(t.db, ids(), old.run.id)).toBeUndefined();
    expect(await getRun(t.db, ids(), recent.run.id)).toBeDefined();
    // A run that is still queued is the sweeper's business, however old.
    expect(await getRun(t.db, ids(), oldActive.id)).toBeDefined();
    const left = (await listFindings(t.db, ids(), { includeSuppressed: true })).items;
    expect(left.map((f) => f.runId)).not.toContain(old.run.id);
    expect(left.map((f) => f.runId)).toContain(recent.run.id);
    expect(lines.join("\n")).toContain("Retention cleanup removed old runs");
  });

  it("is idempotent: a second pass finds nothing", async () => {
    expect(await job().runOnce()).toBe(0);
  });

  it("follows the configured window", async () => {
    const aged = await makeFullRun(t.db, tenant, { at: ago(40) });
    expect(await job(90).runOnce()).toBe(0);
    expect(await job(30).runOnce()).toBe(1);
    expect(await getRun(t.db, ids(), aged.run.id)).toBeUndefined();
  });

  it("runs when started and again on the interval, and stops when told to", async () => {
    vi.useFakeTimers();
    const retention = job();
    const pass = vi.spyOn(retention, "runOnce").mockResolvedValue(0);
    retention.start(60_000);
    expect(pass).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(pass).toHaveBeenCalledTimes(2);
    retention.stop();
    await vi.advanceTimersByTimeAsync(180_000);
    expect(pass).toHaveBeenCalledTimes(2);
  });

  it("logs a failed pass and carries on", async () => {
    vi.useFakeTimers();
    const retention = job();
    vi.spyOn(retention, "runOnce").mockRejectedValue(new Error("connection lost"));
    retention.start(60_000);
    await vi.advanceTimersByTimeAsync(1);
    retention.stop();
    expect(lines.join("\n")).toContain("Retention cleanup failed");
    expect(lines.join("\n")).not.toContain("connection lost");
  });
});

describe("RetentionJob: everything that expires", () => {
  const full = (days = 90) =>
    new RetentionJob({
      db: t.db,
      logger,
      days,
      auditDays: 365,
      webhookDays: 14,
      accessCacheMaxAgeMs: 30 * DAY,
      now: () => NOW,
    });
  const countRows = async (table: string, where = "true") =>
    (await t.pool.query(`select count(*)::int as n from ${table} where ${where}`)).rows[0]
      .n as number;

  it("removes a run's agent runs, findings, comments and feedback together, in one pass (AC-20)", async () => {
    const own = await createTenant(t.db, "together");
    const old = await makeFullRun(t.db, own, { at: ago(100) });
    const keep = await makeFullRun(t.db, own, { at: ago(5) });
    const scope = (id: string) => `run_id = '${id}'`;
    const feedbackOf = (runId: string) =>
      `finding_id in (select id from findings where run_id = '${runId}')`;

    expect(await countRows("agent_runs", scope(old.run.id))).toBeGreaterThan(0);
    expect(await countRows("findings", scope(old.run.id))).toBeGreaterThan(0);
    expect(await countRows("posted_comments", scope(old.run.id))).toBeGreaterThan(0);
    expect(await countRows("finding_feedback", feedbackOf(old.run.id))).toBeGreaterThan(0);

    const result = await full().runAll();
    expect(result.runs).toBeGreaterThanOrEqual(1);

    for (const [table, where] of [
      ["agent_runs", scope(old.run.id)],
      ["findings", scope(old.run.id)],
      ["posted_comments", scope(old.run.id)],
      ["finding_feedback", feedbackOf(old.run.id)],
    ] as const) {
      expect(await countRows(table, where), table).toBe(0);
    }
    // The newer run keeps every one of them: nothing is deleted by age alone.
    for (const [table, where] of [
      ["agent_runs", scope(keep.run.id)],
      ["findings", scope(keep.run.id)],
      ["posted_comments", scope(keep.run.id)],
      ["finding_feedback", feedbackOf(keep.run.id)],
    ] as const) {
      expect(await countRows(table, where), table).toBeGreaterThan(0);
    }
  });

  it("trims the audit log by its own window, the delivery records, and stale access caches", async () => {
    const own = await createTenant(t.db, "bookkeeping");
    await appendAuditLog(t.db, own.installation.id, {
      action: "settings.update",
      target: "old",
      at: ago(400),
    });
    await appendAuditLog(t.db, own.installation.id, {
      action: "settings.update",
      target: "new",
      at: ago(30),
    });
    await recordWebhookDelivery(t.db, { deliveryId: "retention-old", event: "ping" });
    await t.pool.query(
      "update webhook_deliveries set received_at = $1 where delivery_id = 'retention-old'",
      [ago(20)],
    );
    await replaceUserInstallations(t.db, own.user.id, [
      { installationId: own.installation.id, role: "viewer" },
    ]);
    await t.pool.query("update user_installations set refreshed_at = $1 where user_id = $2", [
      ago(45),
      own.user.id,
    ]);

    const result = await full().runAll();

    expect(result.audit).toBe(1);
    expect(await countRows("audit_log", `installation_id = '${own.installation.id}'`)).toBe(1);
    expect(result.webhooks).toBeGreaterThanOrEqual(1);
    expect(await countRows("webhook_deliveries", "delivery_id = 'retention-old'")).toBe(0);
    expect(result.accessCache).toBeGreaterThanOrEqual(1);
    expect(await countRows("user_installations", `user_id = '${own.user.id}'`)).toBe(0);
  });

  it("purges an installation uninstalled longer ago than the window, and only that one", async () => {
    const gone = await createTenant(t.db, "uninstalled");
    const stay = await createTenant(t.db, "recently-uninstalled");
    await makeFullRun(t.db, gone, { at: ago(5) });
    await makeFullRun(t.db, stay, { at: ago(5) });
    for (const [tenantToChange, daysAgo] of [
      [gone, 95],
      [stay, 20],
    ] as const) {
      await t.pool.query(
        "update installations set status = 'deleted', status_changed_at = $2 where id = $1",
        [tenantToChange.installation.id, ago(daysAgo)],
      );
    }
    const result = await full().runAll();
    expect(result.installations).toBe(1);
    expect(await countRows("installations", `id = '${gone.installation.id}'`)).toBe(0);
    expect(await countRows("review_runs", `installation_id = '${gone.installation.id}'`)).toBe(0);
    expect(await countRows("installations", `id = '${stay.installation.id}'`)).toBe(1);
    expect(
      await countRows("review_runs", `installation_id = '${stay.installation.id}'`),
    ).toBeGreaterThan(0);
    expect(lines.join("\n")).toContain("purged uninstalled installations");
  });

  it("runs every step even when one fails, then reports the failure by step name only", async () => {
    // An invalid audit window makes only that step throw; the run step before it and the webhook step after it still run.
    const old = await makeFullRun(t.db, tenant, { at: ago(200) });
    await recordWebhookDelivery(t.db, { deliveryId: "retention-old-2", event: "ping" });
    await t.pool.query(
      "update webhook_deliveries set received_at = $1 where delivery_id = 'retention-old-2'",
      [ago(20)],
    );
    const partial = new RetentionJob({
      db: t.db,
      logger,
      days: 90,
      auditDays: 0,
      webhookDays: 14,
      now: () => NOW,
    });

    await expect(partial.runAll()).rejects.toThrow("Retention steps failed: audit");
    expect(await getRun(t.db, ids(), old.run.id)).toBeUndefined();
    expect(await countRows("webhook_deliveries", "delivery_id = 'retention-old-2'")).toBe(0);
  });
});
