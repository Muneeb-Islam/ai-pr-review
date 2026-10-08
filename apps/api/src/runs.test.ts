// GET /api/runs and GET /api/runs/:id (UI-03, UI-04): what a signed-in user may see, the filters, pagination
// and the shape of the detail. Repository access, not installation membership, decides what is visible.
import { updateRunDetails } from "@ai-pr-review/db";
import { claimRun, saveRunResults, finishClaimedRun } from "@ai-pr-review/db/system";
import { makeFullRun, makeRun, makeRunInStatus, sampleFinding } from "@ai-pr-review/db/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createHarness,
  createWorld,
  type Harness,
  type Session,
  type World,
} from "./testing/harness";

let h: Harness;
let world: World;
let alice: Session;
let victor: Session;
let dana: Session;
let bob: Session;
let carol: Session;

const MINUTE = 60_000;
const t0 = new Date("2026-10-01T10:00:00.000Z").getTime();
const at = (minutes: number) => new Date(t0 + minutes * MINUTE);

interface RunRow {
  id: string;
  repo_full_name: string;
  pr_number: number;
  status: string;
  base_ref: string;
  triggered_by: string | null;
  finding_counts: Record<string, number>;
}
const list = async (s: Session | undefined, query = "") => {
  const res = await h.request(s, "GET", `/api/runs${query}`);
  return { res, body: res.json() as { items: RunRow[]; next_cursor: string | null } };
};

let completedRun: { id: string };
let runningRun: { id: string };
let queuedRun: { id: string };
let secondRepoRun: { id: string };
let betaRun: { id: string };

beforeAll(async () => {
  h = await createHarness();
  world = await createWorld(h);
  // dana belongs to alpha but GitHub only lets her see one of its two repositories.
  h.github.users.set("dana", {
    id: 4242,
    login: "dana",
    installations: [
      {
        id: world.alpha.installation.githubInstallationId,
        accountLogin: world.alpha.installation.accountLogin,
        accountType: "organization",
        orgRole: "member",
        repos: [
          { id: world.alpha.repo.githubRepoId, fullName: world.alpha.repo.fullName, admin: false },
        ],
      },
    ],
  });
  [alice, victor, dana, bob, carol] = await Promise.all([
    h.signIn(world.alice),
    h.signIn(world.victor),
    h.signIn("dana"),
    h.signIn(world.bob),
    h.signIn(world.carol),
  ]);

  const db = h.t.db;
  const full = await makeFullRun(db, world.alpha, { at: at(0), prNumber: 1 });
  completedRun = full.run;
  runningRun = await makeRunInStatus(db, world.alpha, "running", { at: at(10), prNumber: 2 });
  queuedRun = await makeRun(db, world.alpha, { at: at(20), prNumber: 3 });
  await makeRunInStatus(db, world.alpha, "skipped", { at: at(5), prNumber: 4 });
  secondRepoRun = await makeRun(db, world.alpha, {
    repo: world.alpha.repo2,
    at: at(15),
    prNumber: 5,
  });
  betaRun = await makeRun(db, world.beta, { at: at(12), prNumber: 6 });
}, 60_000);
afterAll(async () => {
  await h.close();
});

describe("GET /api/runs", () => {
  it("is empty for someone with no installation and refuses anonymous callers", async () => {
    expect((await list(carol)).body).toEqual({ items: [], next_cursor: null });
    expect((await list(undefined)).res.statusCode).toBe(401);
  });

  it("lists runs newest first, with the repository, the pull request link and finding counts", async () => {
    const { body } = await list(alice);
    expect(body.items.map((r) => r.pr_number)).toEqual([3, 5, 2, 4, 1]);
    const done = body.items.find((r) => r.id === completedRun.id)!;
    expect(done).toMatchObject({
      repo_full_name: world.alpha.repo.fullName,
      status: "completed",
      finding_counts: { critical: 0, high: 1, medium: 0, low: 0, info: 0 },
    });
    const first = (await h.request(alice, "GET", "/api/runs?limit=1")).json().items[0];
    expect(first.pr_url).toBe(`https://github.com/${world.alpha.repo.fullName}/pull/3`);
    // The wire format has no internal fields.
    expect(Object.keys(first).sort()).toEqual(
      [
        "base_ref",
        "finding_counts",
        "finished_at",
        "head_sha",
        "id",
        "parent_run_id",
        "pr_number",
        "pr_url",
        "queued_at",
        "repo_full_name",
        "repo_id",
        "started_at",
        "status",
        "status_reason",
        "trigger",
        "triggered_by",
      ].sort(),
    );
  });

  it("shows each user only the runs of repositories they can reach", async () => {
    // alice and victor reach both alpha repositories; dana only the first one; bob only beta.
    expect((await list(victor)).body.items).toHaveLength(5);
    expect((await list(dana)).body.items.map((r) => r.pr_number).sort()).toEqual([1, 2, 3, 4]);
    expect((await list(bob)).body.items.map((r) => r.pr_number)).toEqual([6]);
  });

  it("treats a repo filter for a repository the caller cannot reach as an empty result", async () => {
    expect((await list(dana, `?repo_id=${world.alpha.repo2.id}`)).body.items).toEqual([]);
    expect((await list(alice, `?repo_id=${world.beta.repo.id}`)).body.items).toEqual([]);
    expect((await list(alice, `?repo_id=${world.alpha.repo2.id}`)).body.items).toHaveLength(1);
  });

  it("filters by status, a list of statuses, branch, author and severity", async () => {
    const pr = async (q: string) => (await list(alice, q)).body.items.map((r) => r.pr_number);
    expect(await pr("?status=running")).toEqual([2]);
    expect(await pr("?status=queued,running")).toEqual([3, 5, 2]);
    expect(await pr("?status=skipped")).toEqual([4]);
    expect(await pr("?branch=main")).toHaveLength(5);
    expect(await pr("?branch=release")).toEqual([]);
    expect(await pr("?author=octocat")).toHaveLength(5);
    expect(await pr("?author=someone-else")).toEqual([]);
    expect(await pr("?severity=high")).toEqual([1]);
    expect(await pr("?severity=critical")).toEqual([]);
  });

  it("filters by the time the run was queued (inclusive bounds)", async () => {
    const pr = async (q: string) => (await list(alice, q)).body.items.map((r) => r.pr_number);
    const iso = (m: number) => encodeURIComponent(at(m).toISOString());
    expect(await pr(`?from=${iso(10)}&to=${iso(15)}`)).toEqual([5, 2]);
    expect(await pr(`?from=${iso(16)}`)).toEqual([3]);
    expect(await pr(`?to=${iso(0)}`)).toEqual([1]);
  });

  it("rejects invalid filters with a 400 that names the field", async () => {
    for (const q of [
      "?status=bogus",
      "?status=queued,bogus",
      "?severity=huge",
      "?from=yesterday",
      "?limit=0",
      "?limit=1000",
    ]) {
      const res = await h.request(alice, "GET", `/api/runs${q}`);
      expect(res.statusCode, q).toBe(400);
      expect(res.json().error.code).toBe("validation_error");
    }
    const cursor = await h.request(alice, "GET", "/api/runs?cursor=garbage");
    expect(cursor.statusCode).toBe(400);
    expect(cursor.json().error.details).toEqual(["cursor: not a valid cursor"]);
  });

  it("pages with a cursor: every run once, in order, and no cursor on the last page", async () => {
    const seen: number[] = [];
    let cursor: string | null = null;
    let pages = 0;
    do {
      const { body } = await list(alice, `?limit=2${cursor ? `&cursor=${cursor}` : ""}`);
      seen.push(...body.items.map((r) => r.pr_number));
      cursor = body.next_cursor;
      pages++;
    } while (cursor);
    expect(seen).toEqual([3, 5, 2, 4, 1]);
    expect(pages).toBe(3);
  });

  it("a cursor from one user does not widen another user's view", async () => {
    const { body } = await list(alice, "?limit=1");
    const asBob = await list(bob, `?cursor=${body.next_cursor}`);
    expect(asBob.body.items.map((r) => r.pr_number)).toEqual([6]);
  });
});

describe("GET /api/runs/:id", () => {
  it("returns the run with agent runs, findings, suppressed counts, usage and links", async () => {
    const res = await h.request(victor, "GET", `/api/runs/${completedRun.id}`);
    expect(res.statusCode).toBe(200);
    const run = res.json();
    expect(run).toMatchObject({
      id: completedRun.id,
      status: "completed",
      base_sha: "b".repeat(40),
      check_run_url: null,
      warnings: [],
      suppressed_counts: { below_threshold: 1 },
      skipped_files: [],
    });
    expect(run.agent_runs).toEqual([
      expect.objectContaining({
        agent: "code_review",
        status: "ok",
        duration_ms: 1200,
        input_tokens: 100,
        output_tokens: 50,
        retries: 0,
      }),
    ]);
    // Suppressed findings are counted, not listed.
    expect(run.findings).toHaveLength(1);
    expect(run.findings[0]).toMatchObject({
      severity: "high",
      file_path: "src/a.ts",
      start_line: 10,
      end_line: 12,
      posted: true,
    });
    expect(Object.keys(run.findings[0])).not.toContain("fingerprint");
    expect(Object.keys(run)).not.toContain("installation_id");
  });

  it("returns skipped files, warnings, usage and the Check Run link a worker recorded", async () => {
    const db = h.t.db;
    const run = await makeRun(db, world.alpha, { prNumber: 20 });
    const claimed = (await claimRun(db, run.id))!;
    await saveRunResults(db, run.id, claimed.attempts, {
      agentRuns: [],
      findings: [sampleFinding({ severity: "critical", agent: "security", category: "security" })],
      warnings: ["Test Coverage timed out"],
      usage: { inputTokens: 1200, outputTokens: 340 },
      skippedFiles: [{ path: "package-lock.json", reason: "lockfile" }],
    });
    await finishClaimedRun(db, run.id, claimed.attempts, "partial", {
      warnings: ["Test Coverage timed out"],
    });
    await updateRunDetails(db, world.alpha.installation.id, run.id, { checkRunId: 4711 });

    const body = (await h.request(alice, "GET", `/api/runs/${run.id}`)).json();
    expect(body).toMatchObject({
      status: "partial",
      warnings: ["Test Coverage timed out"],
      usage: { input_tokens: 1200, output_tokens: 340 },
      skipped_files: [{ path: "package-lock.json", reason: "lockfile" }],
      check_run_url: `https://github.com/${world.alpha.repo.fullName}/runs/4711`,
      finding_counts: { critical: 1 },
    });
  });

  it("returns the measured coverage a worker stored, as counts, paths and line ranges (FR-22)", async () => {
    const db = h.t.db;
    const run = await makeRun(db, world.alpha, { prNumber: 21 });
    const claimed = (await claimRun(db, run.id))!;
    await saveRunResults(db, run.id, claimed.attempts, {
      agentRuns: [],
      findings: [],
      warnings: [],
      usage: { inputTokens: 1, outputTokens: 1 },
      skippedFiles: [],
      coverage: {
        status: "measured",
        changedLineCoverage: 0.6,
        coveredLines: 3,
        totalLines: 5,
        artifact: { name: "coverage", runId: 31 },
        observations: [],
        files: [
          {
            path: "src/a.ts",
            status: "measured",
            coveredLines: 3,
            totalLines: 5,
            uncovered: [{ start: 3, end: 4 }],
            uncoveredFunctions: ["refund"],
            coveredBranches: 1,
            totalBranches: 2,
          },
          {
            path: "src/new.ts",
            status: "not_in_report",
            coveredLines: 0,
            totalLines: 0,
            uncovered: [],
          },
        ],
      },
    });
    await finishClaimedRun(db, run.id, claimed.attempts, "completed");

    const body = (await h.request(alice, "GET", `/api/runs/${run.id}`)).json();
    expect(body.coverage).toEqual({
      status: "measured",
      reason: null,
      reason_code: null,
      changed_line_coverage: 0.6,
      covered_lines: 3,
      total_lines: 5,
      artifact_name: "coverage",
      artifact_run_id: 31,
      observations: [],
      files: [
        {
          path: "src/a.ts",
          status: "measured",
          covered_lines: 3,
          total_lines: 5,
          uncovered: [{ start: 3, end: 4 }],
          uncovered_functions: ["refund"],
          covered_branches: 1,
          total_branches: 2,
        },
        {
          path: "src/new.ts",
          status: "not_in_report",
          covered_lines: 0,
          total_lines: 0,
          uncovered: [],
          uncovered_functions: [],
          covered_branches: null,
          total_branches: null,
        },
      ],
    });
  });

  it("returns why coverage was not measured, and null when the agent did not run", async () => {
    const db = h.t.db;
    const run = await makeRun(db, world.alpha, { prNumber: 22 });
    const claimed = (await claimRun(db, run.id))!;
    await saveRunResults(db, run.id, claimed.attempts, {
      agentRuns: [],
      findings: [],
      warnings: [],
      usage: { inputTokens: 1, outputTokens: 1 },
      skippedFiles: [],
      coverage: {
        status: "not_available",
        reasonCode: "ci_running",
        reason: "CI was still running when the review started, so no coverage report was ready.",
        observations: [],
      },
    });
    const body = (await h.request(alice, "GET", `/api/runs/${run.id}`)).json();
    expect(body.coverage).toMatchObject({
      status: "not_available",
      reason_code: "ci_running",
      reason: expect.stringContaining("CI was still running"),
      changed_line_coverage: null,
      files: [],
      artifact_run_id: null,
    });
    const queued = (await h.request(alice, "GET", `/api/runs/${queuedRun.id}`)).json();
    expect(queued.coverage).toBeNull();
  });

  it("does not show coverage of a run in a repository the viewer cannot reach", async () => {
    expect((await h.request(dana, "GET", `/api/runs/${betaRun.id}`)).statusCode).toBe(404);
  });

  it("is a 404 for a repository the viewer cannot reach, another tenant, and nothing at all", async () => {
    const mine = `/api/runs/${secondRepoRun.id}`;
    expect((await h.request(alice, "GET", mine)).statusCode).toBe(200);
    expect((await h.request(dana, "GET", mine)).statusCode).toBe(404);
    expect((await h.request(bob, "GET", mine)).statusCode).toBe(404);
    expect((await h.request(carol, "GET", mine)).statusCode).toBe(404);
    expect((await h.request(alice, "GET", `/api/runs/${betaRun.id}`)).statusCode).toBe(404);
    expect((await h.request(alice, "GET", "/api/runs/not-a-uuid")).statusCode).toBe(404);
  });

  it("shows a queued and a running run without timings it does not have", async () => {
    const queued = (await h.request(alice, "GET", `/api/runs/${queuedRun.id}`)).json();
    expect(queued).toMatchObject({ status: "queued", started_at: null, finished_at: null });
    const running = (await h.request(alice, "GET", `/api/runs/${runningRun.id}`)).json();
    expect(running.status).toBe("running");
    expect(running.started_at).not.toBeNull();
    expect(running.finished_at).toBeNull();
  });
});
