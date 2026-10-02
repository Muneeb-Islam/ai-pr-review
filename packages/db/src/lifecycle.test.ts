import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { RUN_STATUSES } from "@ai-pr-review/shared";
import { ALLOWED_TRANSITIONS, canTransition } from "./lifecycle";
import { IllegalTransitionError, InvalidInputError, NotFoundError } from "./errors";
import { createRun, getRun, transitionRun, updateRunDetails } from "./tenant";
import { createTenant, makeRun, makeRunInStatus, type Tenant } from "./testing/fixtures";
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

const TERMINAL = RUN_STATUSES.filter((s) => s !== "queued" && s !== "running");

describe("run lifecycle (scope §5.1)", () => {
  it("allows exactly the transitions of the lifecycle diagram", () => {
    expect(ALLOWED_TRANSITIONS.queued).toEqual(["running", "superseded", "cancelled"]);
    expect(ALLOWED_TRANSITIONS.running).toEqual([
      "completed",
      "partial",
      "failed",
      "skipped",
      "superseded",
      "cancelled",
    ]);
    for (const s of TERMINAL) expect(ALLOWED_TRANSITIONS[s]).toEqual([]);
  });

  describe.each(RUN_STATUSES.map((from) => [from]))("from %s", (from) => {
    it.each(RUN_STATUSES.map((to) => [to]))("-> %s", async (to) => {
      const run = await makeRunInStatus(t.db, A, from);
      const at = new Date("2030-01-02T03:04:05.678Z");
      const attempt = transitionRun(t.db, A.installation.id, run.id, to, {
        reason: "because",
        at,
      });

      if (!canTransition(from, to)) {
        await expect(attempt).rejects.toBeInstanceOf(IllegalTransitionError);
        await expect(attempt).rejects.toMatchObject({ from, to });
        // An illegal move changes nothing.
        const after = await getRun(t.db, [A.installation.id], run.id);
        expect(after).toEqual(run);
        return;
      }

      const next = await attempt;
      expect(next.status).toBe(to);
      expect(next.statusReason).toBe("because");
      if (to === "running") {
        expect(next.startedAt).toEqual(at);
        expect(next.finishedAt).toBeNull();
      } else {
        expect(next.finishedAt).toEqual(at);
        // started_at is set when the run started and is never overwritten by a later transition.
        expect(next.startedAt).toEqual(from === "running" ? run.startedAt : null);
      }
    });
  });

  it("never lets a finished run go back to running", async () => {
    const done = await makeRunInStatus(t.db, A, "completed");
    await expect(transitionRun(t.db, A.installation.id, done.id, "running")).rejects.toThrow(
      IllegalTransitionError,
    );
    await expect(transitionRun(t.db, A.installation.id, done.id, "queued")).rejects.toThrow(
      IllegalTransitionError,
    );
  });

  it("stores warnings and usage given with the transition", async () => {
    const run = await makeRunInStatus(t.db, A, "running");
    const done = await transitionRun(t.db, A.installation.id, run.id, "partial", {
      warnings: ["security agent timed out"],
      usage: { inputTokens: 10, outputTokens: 5 },
    });
    expect(done.warnings).toEqual(["security agent timed out"]);
    expect(done.usage).toEqual({ inputTokens: 10, outputTokens: 5 });
  });

  it("requires a reason for skipped, on creation and on transition", async () => {
    const running = await makeRunInStatus(t.db, A, "running");
    await expect(
      transitionRun(t.db, A.installation.id, running.id, "skipped"),
    ).rejects.toBeInstanceOf(InvalidInputError);
    await expect(
      createRun(t.db, A.installation.id, {
        repoId: A.repo.id,
        prNumber: 1,
        headSha: "a".repeat(40),
        baseSha: "b".repeat(40),
        baseRef: "main",
        trigger: "pull_request",
        skip: { reason: "  " },
      }),
    ).rejects.toBeInstanceOf(InvalidInputError);
  });

  it("creates a guard-skipped run directly in skipped, finished and terminal", async () => {
    const at = new Date("2030-02-03T04:05:06.000Z");
    const run = await createRun(t.db, A.installation.id, {
      repoId: A.repo.id,
      prNumber: 7,
      headSha: "c".repeat(40),
      baseSha: "b".repeat(40),
      baseRef: "main",
      trigger: "pull_request",
      skip: { reason: "draft_pull_request" },
      at,
    });
    expect(run).toMatchObject({
      status: "skipped",
      statusReason: "draft_pull_request",
      queuedAt: at,
      finishedAt: at,
      startedAt: null,
    });
    await expect(transitionRun(t.db, A.installation.id, run.id, "running")).rejects.toThrow(
      IllegalTransitionError,
    );
  });

  it("creates runs as queued with no timestamps other than queued_at", async () => {
    const run = await makeRun(t.db, A);
    expect(run.status).toBe("queued");
    expect(run.startedAt).toBeNull();
    expect(run.finishedAt).toBeNull();
    expect(run.queuedAt).toBeInstanceOf(Date);
  });

  it("lets exactly one of two racing transitions win", async () => {
    for (let i = 0; i < 10; i += 1) {
      const run = await makeRunInStatus(t.db, A, "running");
      const results = await Promise.allSettled([
        transitionRun(t.db, A.installation.id, run.id, "completed"),
        transitionRun(t.db, A.installation.id, run.id, "failed"),
        transitionRun(t.db, A.installation.id, run.id, "cancelled"),
      ]);
      const won = results.filter((r) => r.status === "fulfilled");
      const lost = results.filter((r) => r.status === "rejected");
      expect(won).toHaveLength(1);
      expect(lost).toHaveLength(2);
      for (const l of lost) {
        expect((l as PromiseRejectedResult).reason).toBeInstanceOf(IllegalTransitionError);
      }
    }
  });

  it("reports an unknown or foreign run as not found, not as an illegal transition", async () => {
    const run = await makeRunInStatus(t.db, A, "queued");
    await expect(transitionRun(t.db, B.installation.id, run.id, "running")).rejects.toBeInstanceOf(
      NotFoundError,
    );
    await expect(
      transitionRun(t.db, A.installation.id, "00000000-0000-4000-8000-000000000000", "running"),
    ).rejects.toBeInstanceOf(NotFoundError);
    await expect(
      transitionRun(t.db, A.installation.id, "not-a-uuid", "running"),
    ).rejects.toBeInstanceOf(NotFoundError);
    expect((await getRun(t.db, [A.installation.id], run.id))?.status).toBe("queued");
  });

  it("updates run details without touching status or timestamps", async () => {
    const run = await makeRunInStatus(t.db, A, "running");
    const updated = await updateRunDetails(t.db, A.installation.id, run.id, {
      checkRunId: 123,
      summaryCommentId: 456,
    });
    expect(updated).toMatchObject({
      status: "running",
      checkRunId: 123,
      summaryCommentId: 456,
      startedAt: run.startedAt,
      finishedAt: null,
    });
  });
});

describe("database-level lifecycle invariants (for writers that bypass transitionRun)", () => {
  it("rejects a finished run without finished_at and an active run with finished_at", async () => {
    const run = await makeRunInStatus(t.db, A, "running");
    await expect(
      t.pool.query("update review_runs set status = 'completed' where id = $1", [run.id]),
    ).rejects.toMatchObject({ code: "23514" });
    await expect(
      t.pool.query("update review_runs set finished_at = now() where id = $1", [run.id]),
    ).rejects.toMatchObject({ code: "23514" });
  });

  it("rejects a running run without started_at", async () => {
    const run = await makeRun(t.db, A);
    await expect(
      t.pool.query("update review_runs set status = 'running' where id = $1", [run.id]),
    ).rejects.toMatchObject({ code: "23514" });
  });
});
