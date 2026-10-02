import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { InvalidInputError } from "./errors";
import { deleteRunsOlderThan, replaceUserInstallations, recordWebhookDelivery } from "./system";
import {
  appendAuditLog,
  getRun,
  getRepoSettings,
  listAgentRuns,
  listFeedback,
  listFindingsForRun,
  listPostedComments,
  listProviderCredentials,
  listRepositories,
  putProviderCredential,
  upsertRepoSettings,
} from "./tenant";
import {
  createTenant,
  makeFullRun,
  makeRun,
  makeRunInStatus,
  type Tenant,
} from "./testing/fixtures";
import { createTestDatabase, type TestDatabase } from "./testing/testDb";

const DAY = 24 * 60 * 60 * 1000;
const NOW = new Date("2032-06-15T12:00:00.000Z");
const ago = (days: number) => new Date(NOW.getTime() - days * DAY);

let t: TestDatabase;
let A: Tenant;
let B: Tenant;

beforeAll(async () => {
  t = await createTestDatabase();
  A = await createTenant(t.db, "alpha");
  B = await createTenant(t.db, "beta");
}, 30_000);
afterAll(async () => {
  await t.drop();
});

async function count(table: string): Promise<number> {
  const r = await t.pool.query(`select count(*)::int as n from ${table}`);
  return r.rows[0].n;
}

describe("retention: deleteRunsOlderThan", () => {
  it("deletes old runs and their children, and nothing else", async () => {
    const ids = [A.installation.id, B.installation.id];

    // Old finished runs with children, in both installations (retention is platform-wide).
    const oldA = await makeFullRun(t.db, A, { at: ago(100) });
    const oldB = await makeFullRun(t.db, B, { at: ago(95) });
    // Recent finished runs with children.
    const recentA = await makeFullRun(t.db, A, { at: ago(10) });
    const recentB = await makeFullRun(t.db, B, { at: ago(89) });
    // Old but still active: never deleted.
    const oldQueued = await makeRun(t.db, A, { at: ago(120) });
    const oldRunning = await makeRunInStatus(t.db, A, "running", { at: ago(120) });
    // A re-run whose parent is about to be deleted.
    const child = await makeRun(t.db, A, { at: ago(5), parentRunId: oldA.run.id });

    // Everything that is not a run, plus data attached to the settings of the installation.
    await upsertRepoSettings(t.db, A.installation.id, A.repo.id, { fork_prs: "review" });
    await putProviderCredential(t.db, A.installation.id, {
      provider: "deepseek",
      ciphertext: Buffer.from("opaque"),
      keyVersion: 1,
      last4: "abcd",
    });
    await appendAuditLog(t.db, A.installation.id, {
      action: "run.rerun",
      target: "x",
      at: ago(200),
    });
    await recordWebhookDelivery(t.db, {
      deliveryId: "d-1",
      event: "pull_request",
      receivedAt: ago(200),
    });
    await replaceUserInstallations(t.db, A.user.id, [
      { installationId: A.installation.id, role: "admin" },
    ]);

    const before = {
      installations: await count("installations"),
      repositories: await count("repositories"),
      users: await count("users"),
      userInstallations: await count("user_installations"),
      repoSettings: await count("repo_settings"),
      credentials: await count("provider_credentials"),
      audit: await count("audit_log"),
      deliveries: await count("webhook_deliveries"),
      runs: await count("review_runs"),
      agentRuns: await count("agent_runs"),
      findings: await count("findings"),
      comments: await count("posted_comments"),
      feedback: await count("finding_feedback"),
    };

    const deleted = await deleteRunsOlderThan(t.db, 90, NOW);
    expect(deleted).toBe(2);

    // Old runs and every child are gone.
    for (const old of [oldA, oldB]) {
      expect(await getRun(t.db, ids, old.run.id)).toBeUndefined();
      expect(await listAgentRuns(t.db, ids, old.run.id)).toEqual([]);
      expect(await listFindingsForRun(t.db, ids, old.run.id, { includeSuppressed: true })).toEqual(
        [],
      );
      expect(await listPostedComments(t.db, ids, old.run.id)).toEqual([]);
      expect(await listFeedback(t.db, ids, old.finding.id)).toEqual([]);
    }

    // Recent and active runs and all their children are intact.
    for (const keep of [recentA, recentB]) {
      expect(await getRun(t.db, ids, keep.run.id)).toBeDefined();
      expect(await listAgentRuns(t.db, ids, keep.run.id)).toHaveLength(1);
      expect(
        await listFindingsForRun(t.db, ids, keep.run.id, { includeSuppressed: true }),
      ).toHaveLength(2);
      expect(await listPostedComments(t.db, ids, keep.run.id)).toHaveLength(1);
      expect(await listFeedback(t.db, ids, keep.finding.id)).toHaveLength(1);
    }
    expect((await getRun(t.db, ids, oldQueued.id))?.status).toBe("queued");
    expect((await getRun(t.db, ids, oldRunning.id))?.status).toBe("running");
    // The re-run survives; its link to the deleted parent is cleared.
    expect((await getRun(t.db, ids, child.id))?.parentRunId).toBeNull();

    // Exactly the rows of the two old runs are gone from the five run tables...
    expect(await count("review_runs")).toBe(before.runs - 2);
    expect(await count("agent_runs")).toBe(before.agentRuns - 2);
    expect(await count("findings")).toBe(before.findings - 4);
    expect(await count("posted_comments")).toBe(before.comments - 2);
    expect(await count("finding_feedback")).toBe(before.feedback - 2);
    // ...and nothing else changed.
    expect(await count("installations")).toBe(before.installations);
    expect(await count("repositories")).toBe(before.repositories);
    expect(await count("users")).toBe(before.users);
    expect(await count("user_installations")).toBe(before.userInstallations);
    expect(await count("repo_settings")).toBe(before.repoSettings);
    expect(await count("provider_credentials")).toBe(before.credentials);
    expect(await count("audit_log")).toBe(before.audit);
    expect(await count("webhook_deliveries")).toBe(before.deliveries);
    expect(await listRepositories(t.db, ids)).toHaveLength(4);
    expect(await getRepoSettings(t.db, ids, A.repo.id)).toBeDefined();
    expect(await listProviderCredentials(t.db, ids)).toHaveLength(1);
  });

  it("deletes nothing when no run is old enough, and is repeatable", async () => {
    expect(await deleteRunsOlderThan(t.db, 90, NOW)).toBe(0);
    expect(await deleteRunsOlderThan(t.db, 3650, NOW)).toBe(0);
  });

  it("uses the age cutoff: 91 days old goes, 89 days old stays", async () => {
    const old = await makeRunInStatus(t.db, B, "completed", { at: ago(91) });
    const young = await makeRunInStatus(t.db, B, "completed", { at: ago(89) });
    expect(await deleteRunsOlderThan(t.db, 90, NOW)).toBe(1);
    expect(await getRun(t.db, [B.installation.id], old.id)).toBeUndefined();
    expect(await getRun(t.db, [B.installation.id], young.id)).toBeDefined();
  });

  it("rejects a non-positive retention period", async () => {
    for (const days of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      await expect(deleteRunsOlderThan(t.db, days, NOW)).rejects.toBeInstanceOf(InvalidInputError);
    }
  });
});

describe("deleting a run directly", () => {
  it("removes its agent runs, findings, posted comments and feedback", async () => {
    const full = await makeFullRun(t.db, A, { at: ago(1) });
    const ids = [A.installation.id];
    await t.pool.query("delete from review_runs where id = $1", [full.run.id]);
    expect(await listAgentRuns(t.db, ids, full.run.id)).toEqual([]);
    expect(await listFindingsForRun(t.db, ids, full.run.id, { includeSuppressed: true })).toEqual(
      [],
    );
    expect(await listPostedComments(t.db, ids, full.run.id)).toEqual([]);
    expect(await listFeedback(t.db, ids, full.finding.id)).toEqual([]);
  });
});
