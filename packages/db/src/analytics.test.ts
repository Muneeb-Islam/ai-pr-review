// Analytics (UI-07, AC-19) against a real PostgreSQL, with data small enough to compute by hand. The expected
// numbers below are worked out in the comments next to the fixtures, not copied from the output.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { AgentId, AgentRunStatus, RunStatus } from "@ai-pr-review/shared";
import { upsertUser } from "./system";
import {
  analyticsSummary,
  analyticsTimeseries,
  createRun,
  insertFindings,
  recordAgentRun,
  recordPostedComment,
  setFeedback,
  transitionRun,
  type NewFinding,
} from "./tenant";
import { createTenant, sampleFinding, type Tenant } from "./testing/fixtures";
import { createTestDatabase, type TestDatabase } from "./testing/testDb";
import type { Repo } from "./types";

let t: TestDatabase;
let A: Tenant;
let B: Tenant;
let other: Awaited<ReturnType<typeof upsertUser>>;

const at = (iso: string) => new Date(iso);
const SCOPE = { from: at("2032-06-01T00:00:00Z"), to: at("2032-06-15T12:00:00Z") };

interface Spec {
  tenant?: Tenant;
  repo?: Repo;
  pr: number;
  sha: string;
  status: RunStatus;
  queued: string;
  /** Seconds from queued to started, and from started to finished. */
  start?: number;
  took?: number;
  usage?: [number, number];
  agents?: Array<[AgentId, AgentRunStatus]>;
  findings?: NewFinding[];
  summary?: boolean;
}

/** Builds a run through the real data-access functions and walks it to its status. */
async function build(spec: Spec): Promise<{ findingIds: string[] }> {
  const tenant = spec.tenant ?? A;
  const id = tenant.installation.id;
  const queuedAt = at(spec.queued);
  const base = {
    repoId: (spec.repo ?? tenant.repo).id,
    prNumber: spec.pr,
    headSha: spec.sha.padEnd(40, "0"),
    baseSha: "b".repeat(40),
    baseRef: "main",
    trigger: "pull_request" as const,
    at: queuedAt,
  };
  if (spec.status === "skipped") {
    await createRun(t.db, id, { ...base, skip: { reason: "draft_pull_request" } });
    return { findingIds: [] };
  }
  const run = await createRun(t.db, id, base);
  if (spec.status === "queued") return { findingIds: [] };
  if (spec.status === "superseded" || spec.status === "cancelled") {
    await transitionRun(t.db, id, run.id, spec.status, { at: new Date(queuedAt.getTime() + 5000) });
    return { findingIds: [] };
  }
  const startedAt = new Date(queuedAt.getTime() + (spec.start ?? 5) * 1000);
  await transitionRun(t.db, id, run.id, "running", { at: startedAt });
  for (const [agent, status] of spec.agents ?? [["code_review", "ok"]]) {
    await recordAgentRun(t.db, id, run.id, {
      agent,
      status,
      durationMs: 1000,
      inputTokens: 1,
      outputTokens: 1,
      retries: 0,
      warnings: [],
    });
  }
  const stored = await insertFindings(t.db, id, run.id, spec.findings ?? []);
  for (const f of stored.filter((s) => s.posted)) {
    await recordPostedComment(t.db, id, run.id, {
      kind: "review_comment",
      githubId: 1_000_000 + Math.floor(Math.random() * 1_000_000),
      fingerprint: f.fingerprint,
      headSha: run.headSha,
    });
  }
  if (spec.summary) {
    await recordPostedComment(t.db, id, run.id, {
      kind: "summary",
      githubId: 2_000_000 + Math.floor(Math.random() * 1_000_000),
      headSha: run.headSha,
    });
  }
  const [input, output] = spec.usage ?? [0, 0];
  await transitionRun(t.db, id, run.id, spec.status, {
    at: new Date(startedAt.getTime() + (spec.took ?? 60) * 1000),
    usage: { inputTokens: input, outputTokens: output },
  });
  return { findingIds: stored.map((s) => s.id) };
}

const finding = (o: Partial<NewFinding>): NewFinding => sampleFinding(o);

let f1: string;
let f2: string;
let f4: string;
let f5: string;

beforeAll(async () => {
  t = await createTestDatabase();
  A = await createTenant(t.db, "alpha");
  B = await createTenant(t.db, "beta");
  other = await upsertUser(t.db, { githubUserId: 31_000_001, login: "second-user" });

  // PR 1 reviewed twice on the same commit; the second review posts the same comment again (a duplicate).
  const r1 = await build({
    pr: 1,
    sha: "s1",
    status: "completed",
    queued: "2032-06-10T10:00:00Z",
    took: 60,
    usage: [1000, 100],
    summary: true,
    findings: [
      finding({ severity: "high", posted: true, fingerprint: "fp-a" }),
      finding({ severity: "low", fingerprint: "fp-low" }),
      finding({ severity: "info", suppressedReason: "style_only", fingerprint: "fp-info" }),
    ],
  });
  const r2 = await build({
    pr: 1,
    sha: "s1",
    status: "completed",
    queued: "2032-06-10T11:00:00Z",
    start: 10,
    took: 120,
    usage: [2000, 200],
    summary: true,
    findings: [finding({ severity: "high", posted: true, fingerprint: "fp-a" })],
  });
  // PR 2: a security agent that timed out.
  const r3 = await build({
    pr: 2,
    sha: "s2",
    status: "partial",
    queued: "2032-06-11T09:00:00Z",
    took: 180,
    usage: [500, 50],
    summary: true,
    agents: [
      ["code_review", "ok"],
      ["security", "timeout"],
    ],
    findings: [finding({ severity: "medium", posted: true, fingerprint: "fp-b", category: "bug" })],
  });
  await build({
    pr: 3,
    sha: "s3",
    status: "failed",
    queued: "2032-06-11T10:00:00Z",
    took: 30,
    agents: [["code_review", "failed"]],
  });
  await build({ pr: 4, sha: "s4", status: "skipped", queued: "2032-06-12T09:00:00Z" });
  await build({ pr: 5, sha: "s5", status: "superseded", queued: "2032-06-12T10:00:00Z" });
  await build({ pr: 6, sha: "s6", status: "cancelled", queued: "2032-06-12T11:00:00Z" });
  await build({ pr: 7, sha: "s7", status: "queued", queued: "2032-06-13T09:00:00Z" });
  // Another repository of the same installation: no summary comment.
  await build({
    repo: A.repo2,
    pr: 1,
    sha: "w1",
    status: "completed",
    queued: "2032-06-14T09:00:00Z",
    took: 300,
    usage: [100, 10],
  });
  // Outside the range, and another tenant: neither may show up.
  await build({
    pr: 8,
    sha: "old",
    status: "completed",
    queued: "2032-05-01T09:00:00Z",
    usage: [9, 9],
  });
  await build({
    tenant: B,
    pr: 1,
    sha: "b1",
    status: "completed",
    queued: "2032-06-10T10:00:00Z",
    usage: [7777, 777],
    summary: true,
    findings: [finding({ posted: true })],
  });

  f1 = r1.findingIds[0]!;
  f2 = r1.findingIds[1]!;
  f4 = r2.findingIds[0]!;
  f5 = r3.findingIds[0]!;
  // Votes: F1 useful + false positive, F5 useful, F4 already known, and one on a finding that has no inline
  // comment (F2), which is not a vote on a posted finding and must not count.
  await setFeedback(t.db, A.installation.id, {
    findingId: f1,
    userId: A.user.id,
    verdict: "useful",
  });
  await setFeedback(t.db, A.installation.id, {
    findingId: f1,
    userId: other.id,
    verdict: "false_positive",
  });
  await setFeedback(t.db, A.installation.id, {
    findingId: f5,
    userId: A.user.id,
    verdict: "useful",
  });
  await setFeedback(t.db, A.installation.id, {
    findingId: f4,
    userId: A.user.id,
    verdict: "known",
  });
  await setFeedback(t.db, A.installation.id, {
    findingId: f2,
    userId: other.id,
    verdict: "useful",
  });
}, 60_000);

afterAll(async () => {
  await t.drop();
});

const both = () => [A.installation.id, B.installation.id];
const scope = (repoIds: string[]) => ({ repoIds, ...SCOPE });

describe("analyticsSummary", () => {
  it("counts runs by status over the repositories asked about", async () => {
    const s = await analyticsSummary(t.db, both(), scope([A.repo.id, A.repo2.id]));
    // R1, R2, R9 completed; R3 partial; R4 failed; one each skipped, superseded, cancelled; R8 queued.
    expect(s.reviews).toEqual({
      total: 9,
      completed: 3,
      partial: 1,
      failed: 1,
      skipped: 1,
      superseded: 1,
      cancelled: 1,
      in_progress: 1,
    });
  });

  it("takes the median duration of completed and partial runs (60, 120, 180, 300 s -> 150 s)", async () => {
    const s = await analyticsSummary(t.db, both(), scope([A.repo.id, A.repo2.id]));
    expect(s.duration).toEqual({ median_ms: 150_000, sample: 4 });
  });

  it("counts summary coverage over runs that ran to an end (5), 3 of which have a summary", async () => {
    const s = await analyticsSummary(t.db, both(), scope([A.repo.id, A.repo2.id]));
    // Eligible: R1, R2, R3, R4 (failed), R9. Summaries: R1, R2, R3.
    expect(s.summary).toEqual({ eligible: 5, with_summary: 3 });
  });

  it("counts reported findings by severity and separates posted and suppressed ones", async () => {
    const s = await analyticsSummary(t.db, both(), scope([A.repo.id, A.repo2.id]));
    // Reported: F1 high, F2 low, F4 high, F5 medium. Posted: F1, F4, F5. Suppressed: the info one.
    expect(s.findings).toEqual({
      by_severity: { critical: 0, high: 2, medium: 1, low: 1, info: 0 },
      total: 4,
      posted: 3,
      suppressed: 1,
    });
  });

  it("counts votes on posted findings only (AC-19)", async () => {
    const s = await analyticsSummary(t.db, both(), scope([A.repo.id, A.repo2.id]));
    // F1: useful + false positive, F5: useful, F4: known = 4 votes on 3 findings. F2's vote is ignored.
    expect(s.feedback).toEqual({
      votes: 4,
      useful: 2,
      false_positive: 1,
      known: 1,
      rated_findings: 3,
    });
  });

  it("changes when a verdict changes (AC-19)", async () => {
    await setFeedback(t.db, A.installation.id, {
      findingId: f4,
      userId: A.user.id,
      verdict: "false_positive",
    });
    const changed = await analyticsSummary(t.db, both(), scope([A.repo.id]));
    expect(changed.feedback).toMatchObject({ useful: 2, false_positive: 2, known: 0, votes: 4 });
    await setFeedback(t.db, A.installation.id, {
      findingId: f4,
      userId: A.user.id,
      verdict: "known",
    });
    const restored = await analyticsSummary(t.db, both(), scope([A.repo.id]));
    expect(restored.feedback).toMatchObject({ useful: 2, false_positive: 1, known: 1 });
  });

  it("finds the comment the second review posted again for the same commit", async () => {
    const s = await analyticsSummary(t.db, both(), scope([A.repo.id, A.repo2.id]));
    // Runs with inline comments: R1, R2, R3. Only R2 repeats a comment (fp-a on the same commit) of an earlier run.
    expect(s.duplicates).toEqual({ runs_with_comments: 3, runs_with_duplicates: 1 });
  });

  it("reports tokens per repository", async () => {
    const s = await analyticsSummary(t.db, both(), scope([A.repo.id, A.repo2.id]));
    const byRepo = Object.fromEntries(s.usage.map((u) => [u.repoId, u]));
    expect(byRepo[A.repo.id]).toMatchObject({ inputTokens: 3500, outputTokens: 350 });
    expect(byRepo[A.repo2.id]).toMatchObject({ inputTokens: 100, outputTokens: 10 });
    expect(s.usage).toHaveLength(2);
  });

  it("narrows to one repository", async () => {
    const s = await analyticsSummary(t.db, both(), scope([A.repo2.id]));
    expect(s.reviews.total).toBe(1);
    expect(s.findings.total).toBe(0);
    expect(s.summary).toEqual({ eligible: 1, with_summary: 0 });
  });

  it("leaves out runs outside the range", async () => {
    const wide = await analyticsSummary(t.db, both(), {
      repoIds: [A.repo.id, A.repo2.id],
      from: at("2032-04-01T00:00:00Z"),
      to: SCOPE.to,
    });
    expect(wide.reviews.total).toBe(10);
  });

  it("never reaches another installation's data, even when its repository is named", async () => {
    const s = await analyticsSummary(t.db, [A.installation.id], scope([B.repo.id]));
    expect(s.reviews.total).toBe(0);
    expect(s.usage).toEqual([]);
    const own = await analyticsSummary(t.db, [A.installation.id], scope([A.repo.id, B.repo.id]));
    expect(own.reviews.total).toBe(8);
  });

  it("is empty for no repositories or no installations", async () => {
    expect((await analyticsSummary(t.db, both(), scope([]))).reviews.total).toBe(0);
    expect((await analyticsSummary(t.db, [], scope([A.repo.id]))).reviews.total).toBe(0);
  });
});

describe("analyticsTimeseries", () => {
  it("buckets by UTC day with reviews, findings, duration, tokens and causes", async () => {
    const points = await analyticsTimeseries(t.db, both(), scope([A.repo.id, A.repo2.id]), "day");
    expect(points.map((p) => p.start)).toEqual([
      "2032-06-10T00:00:00Z",
      "2032-06-11T00:00:00Z",
      "2032-06-12T00:00:00Z",
      "2032-06-13T00:00:00Z",
      "2032-06-14T00:00:00Z",
    ]);
    const [d10, d11, d12, d13, d14] = points;
    expect(d10).toMatchObject({
      reviews: 2,
      completed: 2,
      median_duration_ms: 90_000,
      input_tokens: 3000,
      output_tokens: 300,
      findings: { critical: 0, high: 2, medium: 0, low: 1, info: 0 },
      causes: { timeout: 0, invalid_output: 0, agent_failed: 0, other: 0 },
    });
    // R3 partial (the security agent timed out) and R4 failed (its only agent failed).
    expect(d11).toMatchObject({
      reviews: 2,
      partial: 1,
      failed: 1,
      median_duration_ms: 180_000,
      findings: { medium: 1 },
      causes: { timeout: 1, agent_failed: 1, invalid_output: 0, other: 0 },
    });
    // Skipped, superseded, cancelled and queued runs are no reviews.
    expect(d12).toMatchObject({ reviews: 0, median_duration_ms: null });
    expect(d13).toMatchObject({ reviews: 0 });
    expect(d14).toMatchObject({ reviews: 1, median_duration_ms: 300_000, input_tokens: 100 });
  });

  it("buckets by ISO week (Monday)", async () => {
    const points = await analyticsTimeseries(t.db, both(), scope([A.repo.id, A.repo2.id]), "week");
    for (const p of points) expect(new Date(p.start).getUTCDay()).toBe(1);
    // 2032-06-10 .. 06-14 fall in one week; the 14th is a Monday, so the last run starts a second week.
    expect(points.reduce((n, p) => n + p.reviews, 0)).toBe(5);
    expect(points.reduce((n, p) => n + p.input_tokens, 0)).toBe(3600);
  });

  it("is empty for nothing in scope", async () => {
    expect(await analyticsTimeseries(t.db, both(), scope([]), "day")).toEqual([]);
    expect(await analyticsTimeseries(t.db, [A.installation.id], scope([B.repo.id]), "day")).toEqual(
      [],
    );
  });
});
