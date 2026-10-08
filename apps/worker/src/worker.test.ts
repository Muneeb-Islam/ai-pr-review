// The queue side against a real Redis (BullMQ) and PostgreSQL, with the mock provider (Phase 8): jobs become
// completed runs, duplicates do not duplicate data, infrastructure errors retry and then dead-letter, one
// installation cannot take every worker, cancel messages stop work, shutdown hands runs back, and the sweeper
// recovers a worker that died.
import { randomBytes } from "node:crypto";
import { listAgentRuns, listFindingsForRun, createRunSupersedingOlder } from "@ai-pr-review/db";
import { claimRun, getRunById } from "@ai-pr-review/db/system";
import { createTestDatabase, type TestDatabase } from "@ai-pr-review/db/testing";
import {
  BullJobQueue,
  createRedisConnection,
  InMemoryRunSignals,
  RedisRunSignals,
  RedisSlotLimiter,
  REVIEW_JOB_NAME,
  UnrecoverableError,
  Worker,
  type SlotLimiter,
} from "@ai-pr-review/queue";
import { createLogger } from "@ai-pr-review/shared";
import type { Redis } from "ioredis";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

vi.setConfig({ testTimeout: 40_000 });
import { ReviewWorker } from "./worker";
import { Sweeper } from "./sweeper";
import {
  bugAnswer,
  buildRig,
  fakeGitHub,
  queuedRun,
  readyTenant,
  redisUrl,
  sleep,
  waitFor,
  type Rig,
  type RigOptions,
} from "./testing";

let t: TestDatabase;
let redis: Redis;
const logger = createLogger({}, () => undefined);
const suffix = randomBytes(4).toString("hex");
let queueCounter = 0;

beforeAll(async () => {
  t = await createTestDatabase();
  redis = createRedisConnection(redisUrl(), "worker");
}, 60_000);
afterAll(async () => {
  redis.disconnect();
  await t.drop();
});

interface Harness {
  queue: BullJobQueue;
  rig: Rig;
  worker: ReviewWorker;
  sweeper: Sweeper;
  limiter: SlotLimiter;
  signals: InMemoryRunSignals;
  queueName: string;
}

const harnesses: Harness[] = [];
afterEach(async () => {
  for (const h of harnesses.splice(0)) {
    await h.worker.stop().catch(() => undefined);
    await h.queue.queue.obliterate({ force: true }).catch(() => undefined);
    await h.queue.deadLetters.obliterate({ force: true }).catch(() => undefined);
    await h.queue.close();
  }
});

interface HarnessOptions extends RigOptions {
  concurrency?: number;
  installationConcurrency?: number;
  attempts?: number;
  shutdownGraceMs?: number;
  staleAfterMs?: number;
  maxRunAttempts?: number;
  /** Do not start the worker (sweeper-only tests). */
  idle?: boolean;
}

async function harness(options: HarnessOptions = {}): Promise<Harness> {
  const queueName = `test-${suffix}-${++queueCounter}`;
  const queue = new BullJobQueue(redis, {
    queueName,
    deadLetterName: `${queueName}-dead`,
    attempts: options.attempts ?? 3,
    backoffMs: 20,
  });
  const rig = buildRig(t, options);
  const limiter = new RedisSlotLimiter(redis, { prefix: `test-slots-${suffix}-${queueCounter}` });
  const sweeper = new Sweeper({
    db: t.db,
    queue,
    signals: rig.signals,
    logger,
    staleAfterMs: options.staleAfterMs ?? 120_000,
    queuedGraceMs: 0,
    maxRunAttempts: options.maxRunAttempts ?? 3,
  });
  const worker = new ReviewWorker({
    db: t.db,
    processor: rig.processor,
    queue,
    connection: redis,
    limiter,
    logger,
    concurrency: options.concurrency ?? 4,
    installationConcurrency: options.installationConcurrency ?? 2,
    shutdownGraceMs: options.shutdownGraceMs ?? 5_000,
    busyDelayMs: 50,
    queueName,
  });
  const h: Harness = { queue, rig, worker, sweeper, limiter, signals: rig.signals, queueName };
  harnesses.push(h);
  if (!options.idle) await worker.start();
  return h;
}

const statusOf = async (runId: string) => (await getRunById(t.db, runId))?.status;
const finished = (runId: string) => async () => {
  const status = await statusOf(runId);
  return status !== "queued" && status !== "running" ? status : undefined;
};

describe("queue and worker (PL-05)", () => {
  it("turns a queued run into a completed one with its history stored", async () => {
    const h = await harness();
    const tenant = await readyTenant(t, "q-happy");
    const run = await queuedRun(t, tenant);

    await h.queue.enqueue(run.id);

    expect(await waitFor("the run to finish", finished(run.id))).toBe("completed");
    const ids = [tenant.installation.id];
    expect(await listFindingsForRun(t.db, ids, run.id)).toHaveLength(1);
    expect(await listAgentRuns(t.db, ids, run.id)).toHaveLength(1);
    // The job is gone when it is done.
    await waitFor("the job to be removed", async () => !(await h.queue.queue.getJob(run.id)));
  });

  it("uses the run id as the job id, so the same run is never queued twice", async () => {
    const h = await harness({ idle: true });
    const tenant = await readyTenant(t, "q-ids");
    const run = await queuedRun(t, tenant);

    await Promise.all([h.queue.enqueue(run.id), h.queue.enqueue(run.id), h.queue.enqueue(run.id)]);

    expect((await h.queue.queue.getJob(run.id))?.id).toBe(run.id);
    expect(await h.queue.queue.getJobCounts("waiting")).toMatchObject({ waiting: 1 });
  });

  it("duplicate job delivery does not duplicate agent runs or findings", async () => {
    const h = await harness({ idle: true });
    const tenant = await readyTenant(t, "q-dup");
    const run = await queuedRun(t, tenant);
    // A second job for the same run under another id (what a Redis failover or a manual re-add would do).
    await h.queue.enqueue(run.id);
    await h.queue.queue.add(REVIEW_JOB_NAME, { runId: run.id }, { jobId: `${run.id}-again` });
    await h.worker.start();

    await waitFor("the run to finish", finished(run.id));
    await waitFor("both jobs to be handled", async () => {
      const counts = await h.queue.queue.getJobCounts("waiting", "active", "delayed");
      return counts.waiting === 0 && counts.active === 0 && counts.delayed === 0;
    });

    const ids = [tenant.installation.id];
    expect(await listAgentRuns(t.db, ids, run.id)).toHaveLength(1);
    expect(await listFindingsForRun(t.db, ids, run.id, { includeSuppressed: true })).toHaveLength(
      1,
    );
    expect(h.rig.provider.calls).toHaveLength(1);
    expect((await getRunById(t.db, run.id))!.attempts).toBe(1);
  });

  it("ignores a job for a run that was superseded while it waited", async () => {
    const h = await harness({ idle: true });
    const tenant = await readyTenant(t, "q-superseded");
    const run = await queuedRun(t, tenant);
    await h.queue.enqueue(run.id);
    await createRunSupersedingOlder(t.db, tenant.installation.id, {
      repoId: tenant.repo.id,
      prNumber: run.prNumber,
      headSha: "b".repeat(40),
      baseSha: "c".repeat(40),
      baseRef: "main",
      trigger: "pull_request",
    });
    await h.worker.start();

    await waitFor("the job to be consumed", async () => !(await h.queue.queue.getJob(run.id)));

    expect(await statusOf(run.id)).toBe("superseded");
    expect(h.rig.provider.calls).toHaveLength(0);
    expect(h.rig.github.calls).toHaveLength(0);
  });

  it("replaces a failed job when a run is queued again (recovery from the database)", async () => {
    const h = await harness({ idle: true });
    const tenant = await readyTenant(t, "q-replace");
    const run = await queuedRun(t, tenant);
    await h.queue.enqueue(run.id);
    // A worker that fails the job for good leaves a failed job with the run's id behind.
    const failing = new Worker(
      h.queueName,
      async () => {
        throw new UnrecoverableError("boom");
      },
      { connection: redis },
    );
    failing.on("error", () => undefined);
    try {
      await waitFor("the job to fail", async () =>
        (await h.queue.queue.getJob(run.id))?.isFailed(),
      );
    } finally {
      await failing.close();
    }

    await h.queue.enqueue(run.id);

    expect(await (await h.queue.queue.getJob(run.id))!.getState()).toBe("waiting");
  });
});

describe("retries, dead letters (PL-05)", () => {
  it("retries infrastructure errors with backoff and then completes the run", async () => {
    let failures = 2;
    const github = fakeGitHub();
    const failing = {
      ...github,
      access: {
        getClient: async () => {
          if (failures-- > 0) throw Object.assign(new Error("bad gateway"), { status: 502 });
          return github.client;
        },
      },
    };
    const h = await harness({ github: failing, attempts: 4 });
    const tenant = await readyTenant(t, "q-retry");
    const run = await queuedRun(t, tenant);

    await h.queue.enqueue(run.id);

    expect(await waitFor("the run to finish", finished(run.id), 20_000)).toBe("completed");
    expect(failures).toBeLessThan(0);
    expect(h.rig.provider.calls).toHaveLength(1);
    expect(await listAgentRuns(t.db, [tenant.installation.id], run.id)).toHaveLength(1);
  });

  it("does not retry a review failure: a missing key fails the run once", async () => {
    const h = await harness();
    const tenant = await readyTenant(t, "q-nokey");
    // A tenant without a key.
    const { createTenant } = await import("@ai-pr-review/db/testing");
    const keyless = await createTenant(t.db, "q-keyless");
    const { upsertInstallationSettings } = await import("@ai-pr-review/db");
    await upsertInstallationSettings(t.db, keyless.installation.id, {
      provider: "deepseek",
      model: "m",
    });
    const run = await queuedRun(t, keyless);

    await h.queue.enqueue(run.id);

    expect(await waitFor("the run to finish", finished(run.id))).toBe("failed");
    expect((await getRunById(t.db, run.id))!.attempts).toBe(1);
    expect(await h.queue.deadLetters.getJobCounts("waiting")).toMatchObject({ waiting: 0 });
    void tenant;
  });

  it("dead-letters a job that ran out of retries and fails its run with a clear message", async () => {
    const down = {
      ...fakeGitHub(),
      access: {
        getClient: async (): Promise<never> => {
          throw Object.assign(new Error("bad gateway"), { status: 503 });
        },
      },
    };
    const h = await harness({ github: down, attempts: 2 });
    const tenant = await readyTenant(t, "q-dead");
    const run = await queuedRun(t, tenant);

    await h.queue.enqueue(run.id);

    expect(await waitFor("the run to fail", finished(run.id), 20_000)).toBe("failed");
    const stored = (await getRunById(t.db, run.id))!;
    expect(stored.statusReason).toContain("infrastructure");
    const dead = await waitFor("a dead letter", async () => {
      const jobs = await h.queue.deadLetters.getJobs(["waiting", "delayed", "completed"]);
      return jobs.length > 0 ? jobs : undefined;
    });
    expect(dead[0]!.data).toMatchObject({ runId: run.id, attempts: 2 });
    expect(JSON.stringify(dead[0]!.data)).not.toContain("bad gateway"); // names only, never messages
  });
});

describe("fairness (PL-11)", () => {
  /** Reply that records how many reviews are in flight at once. */
  function gauge(holdMs: number) {
    const state = { now: 0, max: 0 };
    const reply = async () => {
      state.now++;
      state.max = Math.max(state.max, state.now);
      await sleep(holdMs);
      state.now--;
      return bugAnswer();
    };
    return { state, reply };
  }

  it("never runs more reviews of one installation at once than the cap, however many workers are free", async () => {
    const { state, reply } = gauge(150);
    const h = await harness({
      concurrency: 6,
      installationConcurrency: 1,
      replies: [reply],
    });
    const tenant = await readyTenant(t, "q-fair");
    const runs = [];
    for (let pr = 1; pr <= 3; pr++) runs.push(await queuedRun(t, tenant, pr));

    for (const run of runs) await h.queue.enqueue(run.id);
    for (const run of runs) await waitFor("a run to finish", finished(run.id), 30_000);

    expect(state.max).toBe(1);
    for (const run of runs) expect(await statusOf(run.id)).toBe("completed");
  });

  it("lets different installations run side by side", async () => {
    const { state, reply } = gauge(300);
    const h = await harness({ concurrency: 4, installationConcurrency: 1, replies: [reply] });
    const a = await readyTenant(t, "q-par-a");
    const b = await readyTenant(t, "q-par-b");
    const runA = await queuedRun(t, a);
    const runB = await queuedRun(t, b);

    await Promise.all([h.queue.enqueue(runA.id), h.queue.enqueue(runB.id)]);
    await waitFor(
      "both to finish",
      async () => (await finished(runA.id)()) && (await finished(runB.id)()),
    );

    expect(state.max).toBe(2);
  });

  it("limits a worker process to its global concurrency", async () => {
    const { state, reply } = gauge(150);
    const h = await harness({ concurrency: 2, installationConcurrency: 10, replies: [reply] });
    const runs = [];
    for (let i = 0; i < 4; i++) {
      runs.push(await queuedRun(t, await readyTenant(t, `q-global-${i}`)));
    }

    for (const run of runs) await h.queue.enqueue(run.id);
    for (const run of runs) await waitFor("a run to finish", finished(run.id), 30_000);

    expect(state.max).toBe(2);
  });
});

describe("cancel messages (PL-06, AC-15)", () => {
  it("a run.cancel from the api stops the review in flight, and nothing is published", async () => {
    let started!: () => void;
    const inFlight = new Promise<void>((resolve) => (started = resolve));
    const { ProviderCancelled } = await import("@ai-pr-review/core");
    const h = await harness({
      replies: [
        (req: { signal?: AbortSignal }) =>
          new Promise((_resolve, reject) => {
            started();
            req.signal?.addEventListener("abort", () =>
              reject(new ProviderCancelled("The request was cancelled.", "deepseek")),
            );
          }),
      ],
    });
    const tenant = await readyTenant(t, "q-cancel");
    const run = await queuedRun(t, tenant);

    await h.queue.enqueue(run.id);
    await inFlight;
    // What the api does for a newer push: write the final state, then publish the message.
    await createRunSupersedingOlder(t.db, tenant.installation.id, {
      repoId: tenant.repo.id,
      prNumber: run.prNumber,
      headSha: "b".repeat(40),
      baseSha: "c".repeat(40),
      baseRef: "main",
      trigger: "pull_request",
    });
    await new RedisRunSignals(redis).publishCancel(run.id, "superseded");

    await waitFor("the review to stop", async () => h.rig.processor.active.size === 0);
    expect(await statusOf(run.id)).toBe("superseded");
    expect(h.rig.publisher.published).toHaveLength(0);
    expect(
      await listFindingsForRun(t.db, [tenant.installation.id], run.id, { includeSuppressed: true }),
    ).toEqual([]);
  });
});

describe("graceful shutdown", () => {
  it("lets a running review finish within the grace period", async () => {
    const h = await harness({
      shutdownGraceMs: 5_000,
      replies: [
        async () => {
          await sleep(300);
          return bugAnswer();
        },
      ],
    });
    const tenant = await readyTenant(t, "q-grace");
    const run = await queuedRun(t, tenant);
    await h.queue.enqueue(run.id);
    await waitFor(
      "the review to start",
      async () => h.rig.provider.calls.length > 0 || h.rig.processor.active.size > 0,
    );

    await h.worker.stop();

    expect(await statusOf(run.id)).toBe("completed");
  });

  it("hands a run back after the grace period, and another worker completes it", async () => {
    const { ProviderCancelled } = await import("@ai-pr-review/core");
    const h = await harness({
      shutdownGraceMs: 100,
      replies: [
        (req: { signal?: AbortSignal }) =>
          new Promise((_resolve, reject) => {
            req.signal?.addEventListener("abort", () =>
              reject(new ProviderCancelled("The request was cancelled.", "deepseek")),
            );
          }),
      ],
    });
    const tenant = await readyTenant(t, "q-handback");
    const run = await queuedRun(t, tenant);
    await h.queue.enqueue(run.id);
    await waitFor("the review to start", async () => h.rig.processor.active.size > 0);

    await h.worker.stop();

    expect(["queued", "running"]).toContain(await statusOf(run.id));
    // A second worker on the same queue picks it up (the sweeper would also re-add a lost job).
    const queueName = h.queueName;
    const second = buildRig(t);
    const worker2 = new ReviewWorker({
      db: t.db,
      processor: second.processor,
      queue: h.queue,
      connection: redis,
      limiter: h.limiter,
      logger,
      concurrency: 2,
      installationConcurrency: 2,
      shutdownGraceMs: 1_000,
      queueName,
    });
    await h.queue.enqueue(run.id);
    await worker2.start();
    try {
      expect(await waitFor("the run to finish", finished(run.id), 20_000)).toBe("completed");
      expect((await getRunById(t.db, run.id))!.attempts).toBe(2);
    } finally {
      await worker2.stop();
    }
  });
});

describe("stuck-run recovery (PL-05)", () => {
  const longAgo = () => new Date(Date.now() - 10 * 60_000);

  it("recovers a run whose worker was killed mid-run: heartbeat expired, no job", async () => {
    const h = await harness({ idle: true, staleAfterMs: 60_000 });
    const tenant = await readyTenant(t, "q-killed");
    // The worker claimed the run and died: running, heartbeat ten minutes old, no job in the queue.
    const run = (await claimRun(t.db, (await queuedRun(t, tenant)).id, longAgo()))!;

    const swept = await h.sweeper.sweepOnce();

    expect(swept).toMatchObject({ requeued: 1, failed: 0 });
    expect(await statusOf(run.id)).toBe("queued");
    expect(h.signals.updated.map((e) => e.status)).toContain("queued");
    // A live worker then runs it to completion.
    await h.worker.start();
    expect(await waitFor("the run to finish", finished(run.id))).toBe("completed");
    expect((await getRunById(t.db, run.id))!.attempts).toBe(2);
  });

  it("leaves a healthy running run alone", async () => {
    const h = await harness({ idle: true, staleAfterMs: 60_000 });
    const tenant = await readyTenant(t, "q-healthy");
    const run = (await claimRun(t.db, (await queuedRun(t, tenant)).id))!;

    expect(await h.sweeper.sweepOnce()).toMatchObject({ requeued: 0, failed: 0 });
    expect(await statusOf(run.id)).toBe("running");
  });

  it("fails a run that keeps killing its workers", async () => {
    const h = await harness({ idle: true, staleAfterMs: 60_000, maxRunAttempts: 2 });
    const tenant = await readyTenant(t, "q-poison");
    const first = (await claimRun(t.db, (await queuedRun(t, tenant)).id, longAgo()))!;
    expect(await h.sweeper.sweepOnce()).toMatchObject({ requeued: 1 });
    const second = (await claimRun(t.db, first.id, longAgo()))!;
    expect(second.attempts).toBe(2);

    expect(await h.sweeper.sweepOnce()).toMatchObject({ requeued: 0, failed: 1 });

    const stored = (await getRunById(t.db, first.id))!;
    expect(stored.status).toBe("failed");
    expect(stored.statusReason).toContain("stopped responding");
  });

  it("re-adds the job of a queued run that lost it (Redis is not the source of truth)", async () => {
    const h = await harness({ idle: true });
    const tenant = await readyTenant(t, "q-lost-job");
    const run = await queuedRun(t, tenant);
    expect(await h.queue.queue.getJob(run.id)).toBeUndefined();

    const swept = await h.sweeper.sweepOnce();

    expect(swept.reenqueued).toBeGreaterThanOrEqual(1);
    expect(await h.queue.queue.getJob(run.id)).toBeDefined();
    await h.worker.start();
    expect(await waitFor("the run to finish", finished(run.id))).toBe("completed");
  });

  it("a worker that wakes up after it was presumed dead cannot overwrite its replacement", async () => {
    const h = await harness({ idle: true, staleAfterMs: 60_000 });
    const tenant = await readyTenant(t, "q-zombie");
    const zombie = (await claimRun(t.db, (await queuedRun(t, tenant)).id, longAgo()))!;
    await h.sweeper.sweepOnce();
    const replacement = (await claimRun(t.db, zombie.id))!;

    // The zombie's late write is fenced out by the attempt number.
    const { finishClaimedRun, saveRunResults } = await import("@ai-pr-review/db/system");
    expect(await finishClaimedRun(t.db, zombie.id, zombie.attempts, "completed")).toBeUndefined();
    expect(
      await saveRunResults(t.db, zombie.id, zombie.attempts, {
        agentRuns: [],
        findings: [],
        warnings: [],
        usage: { inputTokens: 1, outputTokens: 1 },
        skippedFiles: [],
      }),
    ).toBe(false);
    expect(replacement.attempts).toBe(2);
    expect(await statusOf(zombie.id)).toBe("running");
  });
});
