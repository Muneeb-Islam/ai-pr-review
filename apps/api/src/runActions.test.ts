// Re-run and cancel (AC-21, Phase 13) against a real PostgreSQL, the real routes and a fake GitHub: a re-run is a
// new queued run linked to the old one for the pull request's CURRENT commit, through the same path as every other
// trigger; cancel stops an active run; both are admin-only and audited.
import { getRun, listAuditLog } from "@ai-pr-review/db";
import { makeRunInStatus, type Tenant } from "@ai-pr-review/db/testing";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  createHarness,
  createWorld,
  type Harness,
  type Session,
  type World,
} from "./testing/harness";
import { sha } from "./webhooks/testing";

let h: Harness;
let world: World;
let alice: Session;
let victor: Session;
let alpha: Tenant;

beforeAll(async () => {
  h = await createHarness();
  world = await createWorld(h);
  alpha = world.alpha;
  [alice, victor] = await Promise.all([h.signIn(world.alice), h.signIn(world.victor)]);
}, 60_000);
afterAll(async () => {
  await h.close();
});

let pr = 100;
beforeEach(() => {
  pr += 1;
  h.queue.jobs.length = 0;
  h.signals.updated.length = 0;
  h.signals.cancelled.length = 0;
  h.gateway.checkRuns.length = 0;
  h.gateway.snapshot = {
    pr: { number: pr, baseRef: "main", headSha: sha(9), isDraft: false, isFork: false },
    baseSha: sha(8),
    state: "open",
  };
});

const rerun = (session: Session, runId: string) =>
  h.request(session, "POST", `/api/runs/${runId}/rerun`);
const cancel = (session: Session, runId: string) =>
  h.request(session, "POST", `/api/runs/${runId}/cancel`);

describe("POST /api/runs/:id/rerun", () => {
  it("queues a new run linked to the old one, for the commit the pull request points at now", async () => {
    const old = await makeRunInStatus(h.t.db, alpha, "completed", {
      prNumber: pr,
      headSha: sha(1),
    });

    const res = await rerun(alice, old.id);
    expect(res.statusCode).toBe(202);
    const body = res.json();
    expect(body.created).toBe(true);
    expect(body.run).toMatchObject({
      status: "queued",
      head_sha: sha(9),
      trigger: "dashboard_rerun",
      triggered_by: world.alice,
      parent_run_id: old.id,
      pr_number: pr,
    });

    // It really is a queued row, handed to the queue, with a queued Check Run and a live update.
    const stored = await getRun(h.t.db, [alpha.installation.id], body.run.id);
    expect(stored).toMatchObject({ status: "queued", parentRunId: old.id, headSha: sha(9) });
    expect(h.queue.jobs).toEqual([body.run.id]);
    expect(h.gateway.checkRuns.map((c) => c.headSha)).toEqual([sha(9)]);
    expect(h.signals.updated.map((e) => e.runId)).toContain(body.run.id);
    // The history keeps the old run untouched.
    expect((await getRun(h.t.db, [alpha.installation.id], old.id))?.status).toBe("completed");
  });

  it("supersedes the pull request's other active run, like a push does", async () => {
    const waiting = await makeRunInStatus(h.t.db, alpha, "queued", {
      prNumber: pr,
      headSha: sha(1),
    });
    const done = await makeRunInStatus(h.t.db, alpha, "completed", {
      prNumber: pr,
      headSha: sha(1),
    });

    const res = await rerun(alice, done.id);
    expect(res.statusCode).toBe(202);
    expect((await getRun(h.t.db, [alpha.installation.id], waiting.id))?.status).toBe("superseded");
    expect(h.signals.cancelled).toEqual([
      { type: "run.cancel", runId: waiting.id, reason: "superseded" },
    ]);
  });

  it("reuses an identical run that is already waiting instead of queueing a second", async () => {
    const old = await makeRunInStatus(h.t.db, alpha, "completed", {
      prNumber: pr,
      headSha: sha(1),
    });
    const first = (await rerun(alice, old.id)).json();
    const second = (await rerun(alice, old.id)).json();
    expect(second.created).toBe(false);
    expect(second.run.id).toBe(first.run.id);
    expect(h.gateway.checkRuns).toHaveLength(1);
  });

  it("is audited with the new run and no secrets", async () => {
    const old = await makeRunInStatus(h.t.db, alpha, "completed", {
      prNumber: pr,
      headSha: sha(1),
    });
    const { run } = (await rerun(alice, old.id)).json();
    const entries = (await listAuditLog(h.t.db, [alpha.installation.id], { limit: 100 })).items;
    const entry = entries.find((e) => e.action === "run.rerun" && e.target === `run:${old.id}`);
    expect(entry).toBeDefined();
    expect(entry?.userId).toBe(alice.userId);
    expect(entry?.metadata).toMatchObject({ new_run_id: run.id, head_sha: sha(9), created: true });
  });

  it("is for admins: a viewer gets 403 and nothing is created", async () => {
    const old = await makeRunInStatus(h.t.db, alpha, "completed", {
      prNumber: pr,
      headSha: sha(1),
    });
    const res = await rerun(victor, old.id);
    expect(res.statusCode).toBe(403);
    expect(h.queue.jobs).toEqual([]);
  });

  it("answers 409 when the pull request is closed", async () => {
    const old = await makeRunInStatus(h.t.db, alpha, "completed", {
      prNumber: pr,
      headSha: sha(1),
    });
    h.gateway.snapshot = { ...h.gateway.snapshot, state: "closed" };
    const res = await rerun(alice, old.id);
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe("pull_request_closed");
    expect(h.queue.jobs).toEqual([]);
  });

  it("answers 409 when GitHub no longer has the pull request", async () => {
    const old = await makeRunInStatus(h.t.db, alpha, "completed", {
      prNumber: pr,
      headSha: sha(1),
    });
    h.gateway.fetchPullRequest = async () => {
      throw Object.assign(new Error("Not Found"), { status: 404 });
    };
    try {
      const res = await rerun(alice, old.id);
      expect(res.statusCode).toBe(409);
      expect(res.json().error.code).toBe("pull_request_gone");
    } finally {
      delete (h.gateway as { fetchPullRequest?: unknown }).fetchPullRequest;
    }
  });

  it("answers 502 when GitHub is down, without leaking its message", async () => {
    const old = await makeRunInStatus(h.t.db, alpha, "completed", {
      prNumber: pr,
      headSha: sha(1),
    });
    h.gateway.failFetch = true;
    try {
      const res = await rerun(alice, old.id);
      expect(res.statusCode).toBe(502);
      expect(res.json().error.code).toBe("github_unavailable");
      expect(res.body).not.toContain("GitHub is down");
    } finally {
      h.gateway.failFetch = false;
    }
  });

  it("records a skipped run, with its reason, when the repository is disabled", async () => {
    const old = await makeRunInStatus(h.t.db, alpha, "completed", {
      repo: alpha.repo2,
      prNumber: pr,
      headSha: sha(1),
    });
    const patched = await h.request(alice, "PATCH", `/api/repos/${alpha.repo2.id}/settings`, {
      body: { enabled: false },
    });
    expect(patched.statusCode).toBe(200);
    try {
      const res = await rerun(alice, old.id);
      expect(res.statusCode).toBe(202);
      expect(res.json().run.status).toBe("skipped");
      expect(res.json().run.status_reason).toMatch(/disabled/i);
      expect(h.queue.jobs).toEqual([]);
    } finally {
      await h.request(alice, "PATCH", `/api/repos/${alpha.repo2.id}/settings`, {
        body: { enabled: true },
      });
    }
  });
});

describe("POST /api/runs/:id/cancel", () => {
  it("cancels a queued run, tells the workers and the dashboard, and audits it", async () => {
    const run = await makeRunInStatus(h.t.db, alpha, "queued", { prNumber: pr, headSha: sha(1) });
    const res = await cancel(alice, run.id);
    expect(res.statusCode).toBe(200);
    expect(res.json().run).toMatchObject({ id: run.id, status: "cancelled" });

    const stored = await getRun(h.t.db, [alpha.installation.id], run.id);
    expect(stored?.status).toBe("cancelled");
    expect(stored?.statusReason).toBe(`Cancelled by ${world.alice}.`);
    expect(stored?.finishedAt).not.toBeNull();
    expect(h.signals.cancelled).toEqual([
      { type: "run.cancel", runId: run.id, reason: "cancelled" },
    ]);
    expect(h.signals.updated.map((e) => [e.runId, e.status])).toContainEqual([run.id, "cancelled"]);

    const entries = (await listAuditLog(h.t.db, [alpha.installation.id], { limit: 100 })).items;
    expect(entries.some((e) => e.action === "run.cancel" && e.target === `run:${run.id}`)).toBe(
      true,
    );
  });

  it("cancels a running run (a worker that still holds it loses its fence)", async () => {
    const run = await makeRunInStatus(h.t.db, alpha, "running", { prNumber: pr, headSha: sha(1) });
    const res = await cancel(alice, run.id);
    expect(res.statusCode).toBe(200);
    expect((await getRun(h.t.db, [alpha.installation.id], run.id))?.status).toBe("cancelled");
  });

  it.each(["completed", "failed", "superseded", "cancelled"] as const)(
    "answers 409 for a run that is already %s",
    async (status) => {
      const run = await makeRunInStatus(h.t.db, alpha, status, { prNumber: pr, headSha: sha(1) });
      const res = await cancel(alice, run.id);
      expect(res.statusCode).toBe(409);
      expect(res.json().error.code).toBe("run_not_active");
      expect(h.signals.cancelled).toEqual([]);
    },
  );

  it("is for admins: a viewer gets 403 and the run keeps going", async () => {
    const run = await makeRunInStatus(h.t.db, alpha, "queued", { prNumber: pr, headSha: sha(1) });
    expect((await cancel(victor, run.id)).statusCode).toBe(403);
    expect((await getRun(h.t.db, [alpha.installation.id], run.id))?.status).toBe("queued");
  });
});
