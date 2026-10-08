// The Phase 14 endpoints against a real PostgreSQL and the real routes: the findings explorer, feedback (AC-19),
// the history of a pull request, analytics, the audit view, the CSV export and the repository file in settings.
// Who may call what is covered for every endpoint by authorization.test.ts; this file is about what they answer.
import {
  appendAuditLog,
  createRun,
  insertFindings,
  recordAgentRun,
  recordPostedComment,
  transitionRun,
  upsertRepoSettings,
  type NewFinding,
} from "@ai-pr-review/db";
import { getDailyUsage } from "@ai-pr-review/db/system";
import { sampleFinding } from "@ai-pr-review/db/testing";
import {
  utcDayStart,
  type AgentId,
  type AgentRunStatus,
  type RunStatus,
} from "@ai-pr-review/shared";
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
let bob: Session;

const DAY = 86_400_000;
/** The harness clock reads 2026-10-02T10:00Z; runs are queued relative to it so the default ranges see them. */
const now = () => h.clock.now().getTime();
const ago = (days: number) => new Date(now() - days * DAY);

beforeAll(async () => {
  h = await createHarness();
  world = await createWorld(h);
  [alice, victor, bob] = await Promise.all([
    h.signIn(world.alice),
    h.signIn(world.victor),
    h.signIn(world.bob),
  ]);
}, 60_000);
afterAll(async () => {
  await h.close();
});

interface Built {
  runId: string;
  headSha: string;
  prNumber: number;
  findingIds: string[];
}

let prCounter = 500;

/** A run of a tenant's repository built through the data-access functions and walked to its status. */
async function build(
  tenant: World["alpha"],
  o: {
    repo?: World["alpha"]["repo"];
    pr?: number;
    sha?: string;
    status?: RunStatus;
    at: Date;
    tookSeconds?: number;
    usage?: [number, number];
    agents?: Array<[AgentId, AgentRunStatus]>;
    findings?: NewFinding[];
    comments?: boolean;
    summary?: boolean;
  },
): Promise<Built> {
  const id = tenant.installation.id;
  const prNumber = o.pr ?? ++prCounter;
  const run = await createRun(h.t.db, id, {
    repoId: (o.repo ?? tenant.repo).id,
    prNumber,
    headSha: (o.sha ?? `sha${prNumber}`).padEnd(40, "0"),
    baseSha: "b".repeat(40),
    baseRef: "main",
    trigger: "pull_request",
    triggeredBy: "octocat",
    at: o.at,
  });
  await transitionRun(h.t.db, id, run.id, "running", { at: o.at });
  for (const [agent, status] of o.agents ?? [["code_review", "ok"]]) {
    await recordAgentRun(h.t.db, id, run.id, {
      agent,
      status,
      durationMs: 1,
      inputTokens: 1,
      outputTokens: 1,
      retries: 0,
      warnings: [],
    });
  }
  const stored = await insertFindings(h.t.db, id, run.id, o.findings ?? []);
  if (o.comments !== false) {
    let n = 0;
    for (const f of stored.filter((s) => s.posted)) {
      await recordPostedComment(h.t.db, id, run.id, {
        kind: "review_comment",
        githubId: 880_000 + prNumber * 10 + ++n,
        fingerprint: f.fingerprint,
        headSha: run.headSha,
      });
    }
  }
  if (o.summary) {
    await recordPostedComment(h.t.db, id, run.id, {
      kind: "summary",
      githubId: 990_000 + prNumber,
      headSha: run.headSha,
    });
  }
  const [input, output] = o.usage ?? [0, 0];
  await transitionRun(h.t.db, id, run.id, o.status ?? "completed", {
    at: new Date(o.at.getTime() + (o.tookSeconds ?? 60) * 1000),
    usage: { inputTokens: input, outputTokens: output },
  });
  return { runId: run.id, headSha: run.headSha, prNumber, findingIds: stored.map((s) => s.id) };
}

const finding = (o: Partial<NewFinding> = {}) => sampleFinding(o);
const get = (s: Session | undefined, url: string) => h.request(s, "GET", url);
const post = (s: Session | undefined, url: string, body: unknown) =>
  h.request(s, "POST", url, { body });

// ---------------------------------------------------------------------------------------------------------

describe("GET /api/findings", () => {
  let first: Built;
  let second: Built;
  let theirs: Built;

  beforeAll(async () => {
    first = await build(world.alpha, {
      at: ago(3),
      findings: [
        finding({
          severity: "critical",
          category: "security",
          agent: "security",
          filePath: "src/auth/login.ts",
          startLine: 7,
          endLine: 9,
          posted: true,
          title: "SQL built from input",
        }),
        finding({
          severity: "low",
          category: "maintainability",
          filePath: "src/util.ts",
          startLine: 3,
          endLine: 3,
          title: "Long function",
        }),
        finding({
          severity: "info",
          filePath: undefined as unknown as string,
          startLine: undefined as unknown as number,
          endLine: undefined as unknown as number,
          title: "General remark",
        }),
        finding({
          severity: "medium",
          filePath: "src/dropped.ts",
          suppressedReason: "below_threshold",
          title: "Dropped one",
        }),
      ],
      agents: [
        ["code_review", "ok"],
        ["security", "ok"],
      ],
    });
    second = await build(world.alpha, {
      repo: world.alpha.repo2,
      at: ago(1),
      findings: [
        finding({
          severity: "high",
          category: "test_gap",
          agent: "test_coverage",
          filePath: "web/app.tsx",
          posted: true,
          title: "No test for retry",
        }),
      ],
    });
    theirs = await build(world.beta, {
      at: ago(1),
      findings: [finding({ title: "Beta only", posted: true })],
    });
  });

  const list = async (s: Session, query = "") => {
    const res = await get(s, `/api/findings${query}`);
    expect(res.statusCode, res.body).toBe(200);
    return res.json() as {
      items: Array<Record<string, unknown> & { title: string; github_url: string | null }>;
      next_cursor: string | null;
    };
  };

  it("lists what the review reported, newest run first, with the run and pull request", async () => {
    const body = await list(alice);
    const titles = body.items.map((i) => i.title);
    // Newest run first; within one run the order is by id, so only its members are asserted.
    expect(titles[0]).toBe("No test for retry");
    expect(titles.slice(1).sort()).toEqual([
      "General remark",
      "Long function",
      "SQL built from input",
    ]);
    expect(body.items[0]).toMatchObject({
      run_id: second.runId,
      repo_full_name: world.alpha.repo2.fullName,
      pr_number: second.prNumber,
      pr_url: `https://github.com/${world.alpha.repo2.fullName}/pull/${second.prNumber}`,
      head_sha: second.headSha,
      posted: true,
      suppressed_reason: null,
      feedback: { useful: 0, false_positive: 0, known: 0, mine: null },
    });
    expect(titles).not.toContain("Dropped one");
  });

  it("never mixes tenants", async () => {
    expect((await list(bob)).items.map((i) => i.title)).toEqual(["Beta only"]);
    const named = await list(alice, `?repo_id=${world.beta.repo.id}`);
    expect(named.items).toEqual([]);
    expect(JSON.stringify(await list(alice))).not.toContain(theirs.runId);
  });

  it("gives a viewer the same findings as an admin", async () => {
    expect((await list(victor)).items).toHaveLength(4);
  });

  it("filters by repository, severity, category, agent, status, path and date", async () => {
    const titles = async (q: string) => (await list(alice, q)).items.map((i) => i.title).sort();
    expect(await titles(`?repo_id=${world.alpha.repo2.id}`)).toEqual(["No test for retry"]);
    expect(await titles("?severity=critical")).toEqual(["SQL built from input"]);
    expect(await titles("?category=test_gap")).toEqual(["No test for retry"]);
    expect(await titles("?agent=security")).toEqual(["SQL built from input"]);
    expect(await titles("?status=posted")).toEqual(["No test for retry", "SQL built from input"]);
    expect(await titles("?status=summary_only")).toEqual(["General remark", "Long function"]);
    expect(await titles("?status=suppressed")).toEqual(["Dropped one"]);
    expect(await titles("?status=all")).toHaveLength(5);
    expect(await titles("?path=AUTH")).toEqual(["SQL built from input"]);
    expect(await titles(`?run_id=${first.runId}`)).toHaveLength(3);
    expect(await titles(`?from=${encodeURIComponent(ago(2).toISOString())}`)).toEqual([
      "No test for retry",
    ]);
    expect(await titles(`?to=${encodeURIComponent(ago(2).toISOString())}`)).toHaveLength(3);
  });

  it("pages with a cursor", async () => {
    const seen: string[] = [];
    let cursor: string | null = null;
    do {
      const body: Awaited<ReturnType<typeof list>> = await list(
        alice,
        `?limit=1${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`,
      );
      expect(body.items.length).toBeLessThanOrEqual(1);
      seen.push(...body.items.map((i) => i.title));
      cursor = body.next_cursor;
    } while (cursor);
    expect(seen[0]).toBe("No test for retry");
    expect(seen.slice(1).sort()).toEqual([
      "General remark",
      "Long function",
      "SQL built from input",
    ]);
  });

  it("rejects values it cannot filter by", async () => {
    for (const q of [
      "?severity=urgent",
      "?status=maybe",
      "?limit=0",
      "?from=yesterday",
      "?cursor=garbage",
    ]) {
      const res = await get(alice, `/api/findings${q}`);
      expect(res.statusCode, q).toBe(400);
    }
  });

  it("links an inline comment to the comment, a finding with a place to the file and line, and a general one to nothing", async () => {
    const byTitle = Object.fromEntries(
      (await list(alice, "?status=all")).items.map((i) => [i.title, i]),
    );
    const comment = byTitle["SQL built from input"]!;
    expect(comment.github_url).toMatch(
      new RegExp(
        `^https://github.com/${world.alpha.repo.fullName}/pull/${first.prNumber}#discussion_r\\d+$`,
      ),
    );
    expect(byTitle["Long function"]!.github_url).toBe(
      `https://github.com/${world.alpha.repo.fullName}/blob/${first.headSha}/src/util.ts#L3`,
    );
    expect(byTitle["General remark"]!.github_url).toBeNull();
  });

  it("gets one finding, and answers 404 for another tenant's", async () => {
    const id = first.findingIds[0]!;
    const one = await get(alice, `/api/findings/${id}`);
    expect(one.statusCode).toBe(200);
    expect(one.json()).toMatchObject({ id, title: "SQL built from input", run_id: first.runId });
    expect((await get(bob, `/api/findings/${id}`)).statusCode).toBe(404);
  });

  it("shows the findings of a run with their feedback and links on the run detail", async () => {
    const detail = (await get(alice, `/api/runs/${first.runId}`)).json();
    const sql = detail.findings.find((f: { title: string }) => f.title === "SQL built from input");
    expect(sql).toMatchObject({ suppressed_reason: null, feedback: { useful: 0, mine: null } });
    expect(sql.github_url).toContain("#discussion_r");
  });
});

// ---------------------------------------------------------------------------------------------------------

describe("POST /api/findings/:id/feedback", () => {
  let built: Built;
  beforeAll(async () => {
    built = await build(world.alpha, {
      at: ago(2),
      findings: [
        finding({ posted: true, title: "Rated" }),
        finding({ suppressedReason: "style_only", title: "Hidden" }),
      ],
    });
  });
  const url = (i = 0) => `/api/findings/${built.findingIds[i]}/feedback`;

  it("records a vote from a viewer and returns the totals with the caller's own", async () => {
    const res = await post(victor, url(), { verdict: "useful", note: "  Saved us an outage  " });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().feedback).toEqual({
      useful: 1,
      false_positive: 0,
      known: 0,
      mine: { verdict: "useful", note: "Saved us an outage" },
    });
  });

  it("keeps one vote per person: voting again replaces it (AC-19)", async () => {
    await post(victor, url(), { verdict: "false_positive" });
    const again = await post(victor, url(), { verdict: "known", note: "" });
    expect(again.json().feedback).toEqual({
      useful: 0,
      false_positive: 0,
      known: 1,
      mine: { verdict: "known", note: null },
    });
  });

  it("adds up the votes of different people and shows each their own", async () => {
    const res = await post(alice, url(), { verdict: "useful" });
    expect(res.json().feedback).toMatchObject({ useful: 1, known: 1, mine: { verdict: "useful" } });
    const asVictor = await get(victor, `/api/findings/${built.findingIds[0]}`);
    expect(asVictor.json().feedback).toMatchObject({
      useful: 1,
      known: 1,
      mine: { verdict: "known" },
    });
  });

  it("refuses a finding the review dropped", async () => {
    const res = await post(alice, url(1), { verdict: "useful" });
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe("finding_suppressed");
  });

  it("refuses unknown verdicts, extra fields and long notes", async () => {
    expect((await post(alice, url(), { verdict: "great" })).statusCode).toBe(400);
    expect((await post(alice, url(), { verdict: "useful", admin: true })).statusCode).toBe(400);
    expect(
      (await post(alice, url(), { verdict: "useful", note: "x".repeat(1001) })).statusCode,
    ).toBe(400);
  });

  it("is invisible to another tenant", async () => {
    expect((await post(bob, url(), { verdict: "useful" })).statusCode).toBe(404);
  });
});

// ---------------------------------------------------------------------------------------------------------

describe("GET /api/repos/:id/pulls/:number/history", () => {
  it("shows what became of the findings from one review to the next", async () => {
    const pr = 7001;
    const a = finding({
      title: "Missing await in checkout",
      filePath: "src/checkout.ts",
      startLine: 20,
      endLine: 22,
      posted: true,
    });
    const b = finding({
      title: "Unchecked array index",
      filePath: "src/list.ts",
      startLine: 5,
      endLine: 5,
      posted: true,
    });
    const c = finding({
      title: "Leaky timer",
      category: "performance",
      filePath: "src/timer.ts",
      startLine: 40,
      endLine: 41,
    });
    await build(world.alpha, { pr, sha: "c1", at: ago(5), findings: [a, b] });
    // The next commit fixes `b`, moves `a` down four lines (same finding) and adds `c`.
    await build(world.alpha, {
      pr,
      sha: "c2",
      at: ago(4),
      findings: [{ ...a, startLine: 24, endLine: 26, fingerprint: "moved-fingerprint0" }, c],
    });
    // A failed run in between says nothing about findings.
    const failed = await build(world.alpha, {
      pr,
      sha: "c3",
      at: ago(3),
      status: "failed",
      agents: [["code_review", "failed"]],
    });
    const body = (await get(alice, `/api/repos/${world.alpha.repo.id}/pulls/${pr}/history`)).json();

    expect(body).toMatchObject({
      repo_full_name: world.alpha.repo.fullName,
      pr_number: pr,
      pr_url: `https://github.com/${world.alpha.repo.fullName}/pull/${pr}`,
      truncated: false,
    });
    expect(body.runs.map((r: { run: { head_sha: string } }) => r.run.head_sha.slice(0, 2))).toEqual(
      ["c1", "c2", "c3"],
    );
    const [r1, r2, r3] = body.runs;
    expect(r1.changes).toMatchObject({ compared_to: null, still_applicable: [], resolved: [] });
    expect(r1.changes.new.map((f: { title: string }) => f.title).sort()).toEqual([
      "Missing await in checkout",
      "Unchecked array index",
    ]);
    expect(r2.changes.compared_to).toBe(r1.run.id);
    expect(r2.changes.new.map((f: { title: string }) => f.title)).toEqual(["Leaky timer"]);
    expect(r2.changes.still_applicable.map((f: { title: string }) => f.title)).toEqual([
      "Missing await in checkout",
    ]);
    expect(r2.changes.resolved.map((f: { title: string }) => f.title)).toEqual([
      "Unchecked array index",
    ]);
    expect(r3.run.id).toBe(failed.runId);
    expect(r3.changes).toBeNull();
    expect(r1.run.finding_counts.high).toBe(2);
  });

  it("answers 404 for a pull request without runs, and for another tenant", async () => {
    expect(
      (await get(alice, `/api/repos/${world.alpha.repo.id}/pulls/99999/history`)).statusCode,
    ).toBe(404);
    expect(
      (await get(bob, `/api/repos/${world.alpha.repo.id}/pulls/7001/history`)).statusCode,
    ).toBe(404);
    expect(
      (await get(alice, `/api/repos/${world.alpha.repo.id}/pulls/zero/history`)).statusCode,
    ).toBe(400);
  });
});

// ---------------------------------------------------------------------------------------------------------

describe("analytics", () => {
  let before: { reviews: { total: number } };
  let ratedFinding: string;

  const summary = async (s: Session, q = "") => {
    const res = await get(s, `/api/analytics/summary${q}`);
    expect(res.statusCode, res.body).toBe(200);
    return res.json();
  };

  beforeAll(async () => {
    // An installation of its own would be cleaner, but the world has two; the numbers below are deltas.
    before = await summary(alice);
    const built = await build(world.alpha, {
      repo: world.alpha.repo2,
      at: ago(0.5),
      status: "completed",
      tookSeconds: 90,
      usage: [1_000_000, 2_000_000],
      summary: true,
      findings: [finding({ posted: true, title: "Rated for analytics" })],
    });
    ratedFinding = built.findingIds[0]!;
  });

  it("covers the last 30 days by default and only the caller's repositories", async () => {
    const a = await summary(alice);
    expect(a.range.to).toBe(h.clock.now().toISOString());
    expect(new Date(a.range.from).getTime()).toBe(now() - 30 * DAY);
    expect(a.repositories).toBe(2);
    expect(a.reviews.total).toBe(before.reviews.total + 1);
    // Beta's runs are in the same database and nobody here may see them.
    const b = await summary(bob);
    expect(b.repositories).toBe(2);
    expect(b.reviews.total).toBeLessThan(a.reviews.total);
  });

  it("narrows to one repository or installation and ignores ones the caller cannot reach", async () => {
    const one = await summary(alice, `?repo_id=${world.alpha.repo2.id}`);
    expect(one.repositories).toBe(1);
    const foreign = await summary(alice, `?repo_id=${world.beta.repo.id}`);
    expect(foreign.repositories).toBe(0);
    expect(foreign.reviews.total).toBe(0);
    expect(
      (await summary(alice, `?installation_id=${world.beta.installation.id}`)).repositories,
    ).toBe(0);
  });

  it("changes when feedback is given (AC-19)", async () => {
    const start = await summary(alice, `?repo_id=${world.alpha.repo2.id}`);
    expect(start.feedback).toMatchObject({
      votes: 0,
      actionable_rate: null,
      false_positive_rate: null,
    });

    await post(victor, `/api/findings/${ratedFinding}/feedback`, { verdict: "useful" });
    const one = await summary(alice, `?repo_id=${world.alpha.repo2.id}`);
    expect(one.feedback).toMatchObject({
      votes: 1,
      useful: 1,
      rated_findings: 1,
      actionable_rate: 1,
      false_positive_rate: 0,
    });

    await post(alice, `/api/findings/${ratedFinding}/feedback`, { verdict: "false_positive" });
    const two = await summary(alice, `?repo_id=${world.alpha.repo2.id}`);
    expect(two.feedback).toMatchObject({
      votes: 2,
      useful: 1,
      false_positive: 1,
      actionable_rate: 0.5,
      false_positive_rate: 0.5,
    });

    // Changing a verdict moves the numbers again, and one person is still one vote.
    await post(alice, `/api/findings/${ratedFinding}/feedback`, { verdict: "useful" });
    const three = await summary(alice, `?repo_id=${world.alpha.repo2.id}`);
    expect(three.feedback).toMatchObject({
      votes: 2,
      useful: 2,
      false_positive: 0,
      actionable_rate: 1,
    });
  });

  it("works out rates and the median from the counts", async () => {
    const s = await summary(alice, `?repo_id=${world.alpha.repo2.id}`);
    expect(s.completion).toEqual({
      rate: 1,
      sample: s.reviews.completed + s.reviews.partial + s.reviews.failed,
    });
    expect(s.duration.median_ms).not.toBeNull();
    expect(s.summary_coverage.rate).toBeCloseTo(
      s.summary_coverage.with_summary / s.summary_coverage.eligible,
    );
    expect(s.duplicates.runs_with_duplicates).toBe(0);
  });

  it("prices tokens with the provider the repository uses, and leaves them unpriced without one", async () => {
    const q = `?repo_id=${world.alpha.repo2.id}`;
    const none = await summary(alice, q);
    expect(none.usage).toMatchObject({
      input_tokens: 1_000_000,
      output_tokens: 2_000_000,
      estimated_cost_usd: null,
      unpriced_tokens: 3_000_000,
    });

    await upsertRepoSettings(
      h.t.db,
      world.alpha.installation.id,
      world.alpha.repo2.id,
      { provider: "deepseek", model: "m" },
      alice.userId,
    );
    const priced = await summary(alice, q);
    // 1M input at $0.30 and 2M output at $0.50.
    expect(priced.usage).toMatchObject({ estimated_cost_usd: 1.3, unpriced_tokens: 0 });
  });

  it("rejects an upside-down or oversized range", async () => {
    expect(
      (await get(alice, `/api/analytics/summary?from=2026-10-02T00:00:00Z&to=2026-09-01T00:00:00Z`))
        .statusCode,
    ).toBe(400);
    expect(
      (await get(alice, `/api/analytics/summary?from=2024-01-01T00:00:00Z&to=2026-10-02T00:00:00Z`))
        .statusCode,
    ).toBe(400);
    expect((await get(alice, `/api/analytics/timeseries?bucket=hour`)).statusCode).toBe(400);
  });

  it("returns a time series with every day of the range, quiet ones included", async () => {
    const res = await get(
      alice,
      `/api/analytics/timeseries?from=2026-09-25T00:00:00Z&to=2026-10-02T10:00:00Z&repo_id=${world.alpha.repo2.id}`,
    );
    const body = res.json();
    expect(body.bucket).toBe("day");
    // 25 September to 2 October, one point per UTC day.
    expect(body.points.map((p: { start: string }) => p.start)).toEqual(
      Array.from({ length: 8 }, (_, i) =>
        new Date(Date.UTC(2026, 8, 25 + i)).toISOString().replace(".000Z", "Z"),
      ),
    );
    const total = body.points.reduce((n: number, p: { reviews: number }) => n + p.reviews, 0);
    expect(total).toBeGreaterThan(0);
    const quiet = body.points.find((p: { reviews: number }) => p.reviews === 0);
    expect(quiet).toMatchObject({
      median_duration_ms: null,
      input_tokens: 0,
      causes: { timeout: 0, other: 0 },
    });
  });

  it("answers a long range in weeks", async () => {
    const res = await get(
      alice,
      `/api/analytics/timeseries?from=2026-04-01T00:00:00Z&to=2026-10-02T10:00:00Z&bucket=day`,
    );
    const body = res.json();
    expect(body.bucket).toBe("week");
    for (const p of body.points) expect(new Date(p.start).getUTCDay()).toBe(1);
  });
});

// ---------------------------------------------------------------------------------------------------------

describe("GET /api/installations/:id/audit", () => {
  it("lists the installation's entries with who did them, newest first, and filters and pages", async () => {
    const id = world.alpha.installation.id;
    const prefix = `/api/installations/${id}/audit`;
    await appendAuditLog(h.t.db, id, {
      userId: alice.userId,
      action: "settings.update",
      target: "repo:x",
      metadata: { keys: ["review"] },
      at: ago(0.2),
    });
    await appendAuditLog(h.t.db, id, {
      userId: alice.userId,
      action: "run.cancel",
      target: "run:y",
      at: ago(0.1),
    });
    await appendAuditLog(h.t.db, world.beta.installation.id, {
      action: "run.cancel",
      target: "run:z",
      at: ago(0.1),
    });

    const all = (await get(alice, prefix)).json();
    expect(all.items[0]).toMatchObject({
      action: "run.cancel",
      target: "run:y",
      user_login: "alice",
    });
    expect(all.items.map((e: { target: string }) => e.target)).not.toContain("run:z");
    expect(
      (await get(alice, `${prefix}?action=settings.update`))
        .json()
        .items.every((e: { action: string }) => e.action === "settings.update"),
    ).toBe(true);

    const page = (await get(alice, `${prefix}?limit=1`)).json();
    expect(page.items).toHaveLength(1);
    expect(page.next_cursor).not.toBeNull();
    expect((await get(alice, `${prefix}?cursor=nope`)).statusCode).toBe(400);
  });
});

// ---------------------------------------------------------------------------------------------------------

describe("GET /api/repos/:id/export", () => {
  const url = (id: string, q: string) => `/api/repos/${id}/export?${q}`;
  let exportRepo: World["alpha"]["repo"];

  beforeAll(async () => {
    // A repository whose rows this test owns; the other tests keep adding to the first.
    exportRepo = world.alpha.repo2;
    await build(world.alpha, {
      repo: exportRepo,
      at: ago(10),
      pr: 8001,
      findings: [
        finding({
          title: '=HYPERLINK("http://evil.example","click")',
          posted: true,
          filePath: "a,b.ts",
        }),
        finding({ title: "Plain, with comma", suppressedReason: "style_only" }),
      ],
    });
  });

  it("downloads the findings as CSV with a header, quoting and a guard against formulas", async () => {
    const res = await get(alice, url(exportRepo.id, "kind=findings"));
    expect(res.statusCode, res.body).toBe(200);
    expect(res.headers["content-type"]).toBe("text/csv; charset=utf-8");
    expect(res.headers["content-disposition"]).toMatch(
      /^attachment; filename="[A-Za-z0-9._-]+-findings-2026-10-02\.csv"$/,
    );
    expect(res.headers["x-export-truncated"]).toBe("false");
    const text = res.body;
    expect(text.startsWith("﻿finding_id,run_id,")).toBe(true);
    const lines = text.trim().split("\r\n");
    expect(lines[0]).toContain("votes_known");
    // The cell that would run as a formula is text, and its quotes are doubled.
    expect(text).toContain(`"'=HYPERLINK(""http://evil.example"",""click"")"`);
    expect(text).toContain(`"a,b.ts"`);
    expect(text).toContain(`"Plain, with comma"`);
    expect(text).toContain(",suppressed,style_only,");
    expect(text).not.toMatch(/^=/m);
  });

  it("downloads the runs as CSV and honours the time range", async () => {
    const all = await get(alice, url(exportRepo.id, "kind=runs"));
    expect(all.statusCode).toBe(200);
    expect(all.body.split("\r\n")[0]).toContain("duration_seconds");
    expect(all.body).toContain("8001");

    const newer = await get(
      alice,
      url(exportRepo.id, `kind=runs&from=${encodeURIComponent(ago(5).toISOString())}`),
    );
    expect(newer.body).not.toContain(`,8001,`);
  });

  it("is for admins of the repository only, and rejects what it cannot export", async () => {
    expect((await get(victor, url(exportRepo.id, "kind=runs"))).statusCode).toBe(403);
    expect((await get(bob, url(exportRepo.id, "kind=runs"))).statusCode).toBe(404);
    expect((await get(undefined, url(exportRepo.id, "kind=runs"))).statusCode).toBe(401);
    expect((await get(alice, url(exportRepo.id, "kind=secrets"))).statusCode).toBe(400);
    expect((await get(alice, url(exportRepo.id, ""))).statusCode).toBe(400);
  });

  it("leaves an audit entry for every export", async () => {
    const log = (
      await get(
        alice,
        `/api/installations/${world.alpha.installation.id}/audit?action=export.csv&limit=100`,
      )
    ).json();
    const entry = log.items.find(
      (e: { metadata: { kind: string } }) => e.metadata.kind === "findings",
    );
    expect(entry).toMatchObject({ user_login: "alice", target: `repo:${exportRepo.id}` });
    expect(entry.metadata.rows).toBeGreaterThan(0);
    expect(entry.metadata.truncated).toBe(false);
  });
});

// ---------------------------------------------------------------------------------------------------------

describe("settings: the repository file and the installation's usage", () => {
  const settings = async (s: Session = alice) =>
    (await get(s, `/api/repos/${world.alpha.repo.id}/settings`)).json();

  it("locks the keys the repository file sets and applies them over the dashboard (design §6)", async () => {
    await upsertRepoSettings(
      h.t.db,
      world.alpha.installation.id,
      world.alpha.repo.id,
      { review: { mode: "warn", minimum_severity: "high" } },
      alice.userId,
    );
    h.repoFile.state = {
      path: ".github/ai-pr-review.yml",
      status: "applied",
      config: { review: { mode: "fail_on_threshold" }, ignore: ["docs/**"] },
      message: null,
    };
    const body = await settings();
    expect(body.repo_file).toEqual({
      path: ".github/ai-pr-review.yml",
      status: "applied",
      message: null,
    });
    expect(body.repo_file_keys).toEqual(["ignore", "review.mode"]);
    // The file wins for the keys it sets; the dashboard's other keys stand.
    expect(body.effective.review).toMatchObject({
      mode: "fail_on_threshold",
      minimum_severity: "high",
    });
    expect(body.effective.ignore).toEqual(["docs/**"]);
    expect(body.config).toEqual({ review: { mode: "warn", minimum_severity: "high" } });
    // A viewer sees the same (read-only is the point of showing it).
    expect((await settings(victor)).repo_file_keys).toEqual(["ignore", "review.mode"]);
  });

  it("says when the file is absent, invalid or could not be read", async () => {
    for (const status of ["absent", "invalid", "unavailable"] as const) {
      h.repoFile.state = {
        path: ".github/ai-pr-review.yml",
        status,
        config: {},
        message: status === "absent" ? null : "A fixed sentence.",
      };
      const body = await settings();
      expect(body.repo_file.status).toBe(status);
      expect(body.repo_file_keys).toEqual([]);
    }
  });

  it("does not let a patch change what the file sets, but the dashboard value is kept underneath", async () => {
    h.repoFile.state = {
      path: ".github/ai-pr-review.yml",
      status: "applied",
      config: { fork_prs: "review" },
      message: null,
    };
    const res = await h.request(alice, "PATCH", `/api/repos/${world.alpha.repo.id}/settings`, {
      body: { config: { fork_prs: "skip" } },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().config.fork_prs).toBe("skip");
    expect(res.json().effective.fork_prs).toBe("review");
  });

  it("reports the installation's usage today, its quotas and the retention window", async () => {
    const res = await get(alice, `/api/installations/${world.alpha.installation.id}/settings`);
    const body = res.json();
    const usage = await getDailyUsage(
      h.t.db,
      world.alpha.installation.id,
      utcDayStart(h.clock.now()),
    );
    expect(body.usage_today).toEqual({
      runs: usage.runs,
      tokens: usage.tokens,
      resets_at: "2026-10-03T00:00:00.000Z",
    });
    expect(body.quotas).toMatchObject({
      runs_per_day: 200,
      tokens_per_day: 2_000_000,
      read_only: true,
    });
    expect(body.retention).toEqual({ days: 90, read_only: true });
  });
});
