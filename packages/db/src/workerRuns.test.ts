// The worker's view of the run lifecycle (Phase 8) against a real PostgreSQL: atomic claim, heartbeat,
// fenced and idempotent result saving, requeue, stale-run recovery and daily usage (quota) counting.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { QUOTA_EXCEEDED, utcDayStart } from "@ai-pr-review/shared";
import {
  checkDailyQuota,
  claimRun,
  finishClaimedRun,
  getDailyUsage,
  getRunById,
  listStaleQueuedRuns,
  listStaleRunningRuns,
  recoverStaleRun,
  requeueRun,
  saveRunResults,
  touchRunHeartbeat,
  type RunResults,
} from "./system";
import { listAgentRuns, listFindingsForRun, transitionRun } from "./tenant";
import {
  createTenant,
  makeRun,
  makeRunInStatus,
  sampleFinding,
  type Tenant,
} from "./testing/fixtures";
import { createTestDatabase, type TestDatabase } from "./testing/testDb";

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

const agentRun = (agent: "code_review" | "security" = "code_review") => ({
  agent,
  status: "ok" as const,
  durationMs: 1200,
  inputTokens: 100,
  outputTokens: 40,
  retries: 0,
  warnings: [],
});

const results = (overrides: Partial<RunResults> = {}): RunResults => ({
  agentRuns: [agentRun()],
  findings: [sampleFinding({ fingerprint: "fp-accepted-0001" })],
  warnings: ["a warning"],
  usage: { inputTokens: 100, outputTokens: 40 },
  skippedFiles: [{ path: "dist/a.js", reason: "build output" }],
  ...overrides,
});

describe("claimRun", () => {
  it("moves a queued run to running exactly once", async () => {
    const run = await makeRun(t.db, A);
    const [first, second] = await Promise.all([claimRun(t.db, run.id), claimRun(t.db, run.id)]);
    const winners = [first, second].filter(Boolean);
    expect(winners).toHaveLength(1);
    expect(winners[0]).toMatchObject({ status: "running", attempts: 1 });
    expect(winners[0]!.startedAt).toBeInstanceOf(Date);
    expect(winners[0]!.heartbeatAt).toBeInstanceOf(Date);
  });

  it.each(["superseded", "cancelled", "running", "completed"] as const)(
    "does not claim a %s run",
    async (status) => {
      const run = await makeRunInStatus(t.db, A, status);
      expect(await claimRun(t.db, run.id)).toBeUndefined();
    },
  );

  it("ignores ids that are not run ids", async () => {
    expect(await claimRun(t.db, "not-a-uuid")).toBeUndefined();
  });
});

describe("heartbeat", () => {
  it("is accepted for the attempt that claimed the run and refused after a supersede", async () => {
    const run = (await claimRun(t.db, (await makeRun(t.db, A)).id))!;
    expect(await touchRunHeartbeat(t.db, run.id, run.attempts)).toBe(true);
    expect(await touchRunHeartbeat(t.db, run.id, run.attempts + 1)).toBe(false);
    await transitionRun(t.db, A.installation.id, run.id, "superseded");
    expect(await touchRunHeartbeat(t.db, run.id, run.attempts)).toBe(false);
  });
});

describe("saveRunResults", () => {
  it("stores agent runs, findings (accepted and suppressed), warnings, usage and skipped files", async () => {
    const run = (await claimRun(t.db, (await makeRun(t.db, A)).id))!;
    const saved = await saveRunResults(
      t.db,
      run.id,
      run.attempts,
      results({
        findings: [
          sampleFinding({ fingerprint: "fp-accepted-0001" }),
          sampleFinding({ fingerprint: "fp-low-0000000001", suppressedReason: "below_threshold" }),
        ],
      }),
    );
    expect(saved).toBe(true);

    const ids = [A.installation.id];
    expect(await listAgentRuns(t.db, ids, run.id)).toHaveLength(1);
    expect(await listFindingsForRun(t.db, ids, run.id)).toHaveLength(1);
    expect(await listFindingsForRun(t.db, ids, run.id, { includeSuppressed: true })).toHaveLength(
      2,
    );
    expect(await getRunById(t.db, run.id)).toMatchObject({
      warnings: ["a warning"],
      usage: { inputTokens: 100, outputTokens: 40 },
      skippedFiles: [{ path: "dist/a.js", reason: "build output" }],
      status: "running",
    });
  });

  it("stores the Test Coverage measurement with the run, and keeps it when a later save has none (FR-22)", async () => {
    const run = (await claimRun(t.db, (await makeRun(t.db, A)).id))!;
    expect((await getRunById(t.db, run.id))!.coverage).toBeNull();

    const measured = {
      status: "measured" as const,
      changedLineCoverage: 0.6,
      coveredLines: 3,
      totalLines: 5,
      artifact: { name: "coverage", runId: 31 },
      files: [
        {
          path: "src/a.ts",
          status: "measured" as const,
          coveredLines: 3,
          totalLines: 5,
          uncovered: [{ start: 3, end: 3 }],
        },
      ],
      observations: [],
    };
    expect(await saveRunResults(t.db, run.id, run.attempts, results({ coverage: measured }))).toBe(
      true,
    );
    expect((await getRunById(t.db, run.id))!.coverage).toEqual(measured);

    // A repeated save without coverage (the agent was not part of it) does not erase what was measured.
    await saveRunResults(t.db, run.id, run.attempts, results());
    expect((await getRunById(t.db, run.id))!.coverage).toEqual(measured);
  });

  it("bounds what is stored for coverage: files, ranges, names and text", async () => {
    const run = (await claimRun(t.db, (await makeRun(t.db, A)).id))!;
    const files = Array.from({ length: 300 }, (_, i) => ({
      path: `src/f${i}.ts`,
      status: "measured" as const,
      coveredLines: 0,
      totalLines: 200,
      uncovered: Array.from({ length: 80 }, (_, n) => ({ start: n * 2 + 1, end: n * 2 + 1 })),
      uncoveredFunctions: Array.from({ length: 30 }, (_, n) => `fn${n}`),
    }));
    await saveRunResults(
      t.db,
      run.id,
      run.attempts,
      results({
        coverage: {
          status: "not_available",
          reason: "x".repeat(5_000),
          files,
          observations: Array.from({ length: 50 }, () => "note"),
        },
      }),
    );
    const stored = (await getRunById(t.db, run.id))!.coverage!;
    expect(stored.files).toHaveLength(100);
    expect(stored.files![0]!.uncovered).toHaveLength(25);
    expect(stored.files![0]!.uncoveredFunctions).toHaveLength(10);
    expect(stored.reason!.length).toBeLessThanOrEqual(400);
    expect(stored.observations).toHaveLength(10);
  });

  it("is idempotent: saving twice duplicates nothing", async () => {
    const run = (await claimRun(t.db, (await makeRun(t.db, A)).id))!;
    const payload = results({
      agentRuns: [agentRun("code_review"), agentRun("security")],
      findings: [
        sampleFinding({ fingerprint: "fp-accepted-0001" }),
        // A duplicate of the accepted finding shares its fingerprint; two copies must collapse to one row.
        sampleFinding({ fingerprint: "fp-accepted-0001", suppressedReason: "duplicate" }),
        sampleFinding({ fingerprint: "fp-accepted-0001", suppressedReason: "duplicate" }),
      ],
    });
    expect(await saveRunResults(t.db, run.id, run.attempts, payload)).toBe(true);
    expect(await saveRunResults(t.db, run.id, run.attempts, payload)).toBe(true);

    const ids = [A.installation.id];
    expect(await listAgentRuns(t.db, ids, run.id)).toHaveLength(2);
    expect(await listFindingsForRun(t.db, ids, run.id, { includeSuppressed: true })).toHaveLength(
      2,
    );
  });

  it("replaces the unposted findings of an earlier attempt but keeps the posted flag of a repeated one", async () => {
    const run = (await claimRun(t.db, (await makeRun(t.db, A)).id))!;
    await saveRunResults(
      t.db,
      run.id,
      run.attempts,
      results({
        findings: [
          sampleFinding({ fingerprint: "fp-kept-000000001", posted: true }),
          sampleFinding({ fingerprint: "fp-gone-00000001" }),
        ],
      }),
    );
    await saveRunResults(
      t.db,
      run.id,
      run.attempts,
      results({
        findings: [
          sampleFinding({ fingerprint: "fp-kept-000000001", title: "Reworded" }),
          sampleFinding({ fingerprint: "fp-new-000000001" }),
        ],
      }),
    );
    const stored = await listFindingsForRun(t.db, [A.installation.id], run.id);
    expect(stored.map((f) => f.fingerprint).sort()).toEqual([
      "fp-kept-000000001",
      "fp-new-000000001",
    ]);
    const kept = stored.find((f) => f.fingerprint === "fp-kept-000000001")!;
    expect(kept).toMatchObject({ title: "Reworded", posted: true });
  });

  it("refuses to save for a superseded run or a stale attempt, and keeps nothing", async () => {
    const run = (await claimRun(t.db, (await makeRun(t.db, A)).id))!;
    expect(await saveRunResults(t.db, run.id, run.attempts + 1, results())).toBe(false);
    await transitionRun(t.db, A.installation.id, run.id, "superseded");
    expect(await saveRunResults(t.db, run.id, run.attempts, results())).toBe(false);
    expect(
      await listFindingsForRun(t.db, [A.installation.id], run.id, { includeSuppressed: true }),
    ).toEqual([]);
    expect(await listAgentRuns(t.db, [A.installation.id], run.id)).toEqual([]);
  });

  it("caps the stored list of skipped files", async () => {
    const run = (await claimRun(t.db, (await makeRun(t.db, A)).id))!;
    const many = Array.from({ length: 700 }, (_, i) => ({ path: `f${i}.js`, reason: "generated" }));
    await saveRunResults(t.db, run.id, run.attempts, results({ skippedFiles: many }));
    expect((await getRunById(t.db, run.id))!.skippedFiles).toHaveLength(500);
  });
});

describe("finishClaimedRun and requeueRun", () => {
  it("finishes a claimed run once, with the final status, reason and finished_at", async () => {
    const run = (await claimRun(t.db, (await makeRun(t.db, A)).id))!;
    const done = await finishClaimedRun(t.db, run.id, run.attempts, "partial", {
      warnings: ["w"],
      usage: { inputTokens: 5, outputTokens: 6 },
    });
    expect(done).toMatchObject({ status: "partial", usage: { inputTokens: 5, outputTokens: 6 } });
    expect(done!.finishedAt).toBeInstanceOf(Date);
    expect(await finishClaimedRun(t.db, run.id, run.attempts, "completed")).toBeUndefined();
  });

  it("does not overwrite a superseded run, nor accept a stale attempt", async () => {
    const run = (await claimRun(t.db, (await makeRun(t.db, A)).id))!;
    expect(await finishClaimedRun(t.db, run.id, run.attempts + 1, "completed")).toBeUndefined();
    await transitionRun(t.db, A.installation.id, run.id, "superseded");
    expect(await finishClaimedRun(t.db, run.id, run.attempts, "completed")).toBeUndefined();
    expect((await getRunById(t.db, run.id))!.status).toBe("superseded");
  });

  it("insists on a reason for skipped and refuses non-terminal targets", async () => {
    const run = (await claimRun(t.db, (await makeRun(t.db, A)).id))!;
    await expect(finishClaimedRun(t.db, run.id, run.attempts, "skipped")).rejects.toThrow(/reason/);
    await expect(finishClaimedRun(t.db, run.id, run.attempts, "queued")).rejects.toThrow();
  });

  it("requeues a running run for another attempt, which gets a new fencing token", async () => {
    const run = (await claimRun(t.db, (await makeRun(t.db, A)).id))!;
    const back = await requeueRun(t.db, run.id, run.attempts, "shutting down");
    expect(back).toMatchObject({ status: "queued", startedAt: null, heartbeatAt: null });
    expect(await requeueRun(t.db, run.id, run.attempts, "again")).toBeUndefined();
    const second = (await claimRun(t.db, run.id))!;
    expect(second.attempts).toBe(2);
    // The first worker's late write is refused.
    expect(await finishClaimedRun(t.db, run.id, run.attempts, "completed")).toBeUndefined();
  });
});

describe("stuck-run recovery", () => {
  const longAgo = new Date(Date.now() - 10 * 60_000);
  const staleBefore = () => new Date(Date.now() - 2 * 60_000);

  it("lists only running runs whose heartbeat is old, and requeues them", async () => {
    const fresh = (await claimRun(t.db, (await makeRun(t.db, A)).id))!;
    const stuck = (await claimRun(t.db, (await makeRun(t.db, A)).id, longAgo))!;

    const ids = (await listStaleRunningRuns(t.db, staleBefore())).map((r) => r.id);
    expect(ids).toContain(stuck.id);
    expect(ids).not.toContain(fresh.id);

    expect(await recoverStaleRun(t.db, stuck, staleBefore(), 3)).toBe("requeued");
    expect((await getRunById(t.db, stuck.id))!.status).toBe("queued");
    // Repeating the sweep is harmless.
    expect(await recoverStaleRun(t.db, stuck, staleBefore(), 3)).toBe("not_stale");
  });

  it("fails a run that has been started too many times", async () => {
    const run = (await claimRun(t.db, (await makeRun(t.db, A)).id, longAgo))!;
    expect(await recoverStaleRun(t.db, { id: run.id, attempts: 3 }, staleBefore(), 3)).toBe(
      "not_stale",
    );
    const exhausted = { id: run.id, attempts: run.attempts };
    expect(await recoverStaleRun(t.db, exhausted, staleBefore(), 1)).toBe("failed");
    const after = (await getRunById(t.db, run.id))!;
    expect(after.status).toBe("failed");
    expect(after.finishedAt).toBeInstanceOf(Date);
  });

  it("leaves a run alone that woke up in the meantime", async () => {
    const run = (await claimRun(t.db, (await makeRun(t.db, A)).id, longAgo))!;
    await touchRunHeartbeat(t.db, run.id, run.attempts);
    expect(await recoverStaleRun(t.db, run, staleBefore(), 3)).toBe("not_stale");
    expect((await getRunById(t.db, run.id))!.status).toBe("running");
  });

  it("lists queued runs that have waited long enough to have lost their job", async () => {
    const old = await makeRun(t.db, A, { at: longAgo });
    const young = await makeRun(t.db, A);
    const ids = (await listStaleQueuedRuns(t.db, staleBefore())).map((r) => r.id);
    expect(ids).toContain(old.id);
    expect(ids).not.toContain(young.id);
  });
});

describe("daily usage and quota", () => {
  const day = utcDayStart();
  const limits = { runsPerDay: 3, tokensPerDay: 1_000 };

  it("counts today's started and queued runs and their tokens, for one installation only", async () => {
    const tenant = await createTenant(t.db, "quota");
    const other = await createTenant(t.db, "quota-other");
    const done = (await claimRun(t.db, (await makeRun(t.db, tenant)).id))!;
    await finishClaimedRun(t.db, done.id, done.attempts, "completed", {
      usage: { inputTokens: 300, outputTokens: 100 },
    });
    await makeRun(t.db, tenant); // queued: counts as a run
    // Do not count: skipped (a guard), superseded before it started, yesterday's run, another tenant's.
    const skipped = (await claimRun(t.db, (await makeRun(t.db, tenant)).id))!;
    await finishClaimedRun(t.db, skipped.id, skipped.attempts, "skipped", { reason: "too large" });
    await makeRunInStatus(t.db, tenant, "superseded");
    await makeRun(t.db, tenant, { at: new Date(day.getTime() - 3_600_000) });
    await makeRun(t.db, other);

    expect(await getDailyUsage(t.db, tenant.installation.id, day)).toEqual({
      runs: 2,
      tokens: 400,
    });
  });

  it("excludes the run being decided on", async () => {
    const tenant = await createTenant(t.db, "quota-self");
    const run = await makeRun(t.db, tenant);
    expect(await getDailyUsage(t.db, tenant.installation.id, day)).toMatchObject({ runs: 1 });
    expect(await getDailyUsage(t.db, tenant.installation.id, day, run.id)).toMatchObject({
      runs: 0,
    });
  });

  it("refuses once the run limit or the token limit is reached (AC-23)", async () => {
    const tenant = await createTenant(t.db, "quota-limit");
    for (let i = 0; i < 3; i++) await makeRun(t.db, tenant);
    const byRuns = await checkDailyQuota(t.db, tenant.installation.id, limits, { since: day });
    expect(byRuns).toMatchObject({ allowed: false });
    expect(!byRuns.allowed && byRuns.reason).toContain(QUOTA_EXCEEDED);

    const heavy = await createTenant(t.db, "quota-heavy");
    const run = (await claimRun(t.db, (await makeRun(t.db, heavy)).id))!;
    await finishClaimedRun(t.db, run.id, run.attempts, "completed", {
      usage: { inputTokens: 900, outputTokens: 100 },
    });
    const byTokens = await checkDailyQuota(t.db, heavy.installation.id, limits, { since: day });
    expect(!byTokens.allowed && byTokens.reason).toContain("tokens");

    const fine = await checkDailyQuota(t.db, B.installation.id, limits, { since: day });
    expect(fine).toEqual({ allowed: true, remainingRuns: 3, remainingTokens: 1_000 });
  });
});
