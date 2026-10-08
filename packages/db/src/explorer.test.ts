// The findings explorer, feedback totals, comment links and per-PR history (UI-05) against a real PostgreSQL.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { upsertUser } from "./system";
import {
  createRun,
  findInlineCommentIds,
  getFindingWithRun,
  insertFindings,
  listAuditEntries,
  appendAuditLog,
  listFindingsWithRuns,
  listPullHistory,
  recordAgentRun,
  recordPostedComment,
  setFeedback,
  summarizeFeedback,
  transitionRun,
  type NewFinding,
} from "./tenant";
import { createTenant, sampleFinding, type Tenant } from "./testing/fixtures";
import { createTestDatabase, type TestDatabase } from "./testing/testDb";

let t: TestDatabase;
let A: Tenant;
let B: Tenant;

const DAY = 24 * 60 * 60 * 1000;
const T0 = new Date("2032-03-01T09:00:00.000Z").getTime();
const at = (days: number) => new Date(T0 + days * DAY);

async function review(
  tenant: Tenant,
  opts: {
    repo?: Tenant["repo"];
    pr: number;
    sha: string;
    day: number;
    findings: NewFinding[];
    agents?: Array<["code_review" | "security" | "test_coverage", "ok" | "timeout" | "failed"]>;
    status?: "completed" | "partial";
  },
) {
  const id = tenant.installation.id;
  const run = await createRun(t.db, id, {
    repoId: (opts.repo ?? tenant.repo).id,
    prNumber: opts.pr,
    headSha: opts.sha.padEnd(40, "0"),
    baseSha: "b".repeat(40),
    baseRef: "main",
    trigger: "pull_request",
    at: at(opts.day),
  });
  await transitionRun(t.db, id, run.id, "running", { at: at(opts.day) });
  for (const [agent, status] of opts.agents ?? [["code_review", "ok"]]) {
    await recordAgentRun(t.db, id, run.id, {
      agent,
      status,
      durationMs: 1,
      inputTokens: 0,
      outputTokens: 0,
      retries: 0,
      warnings: [],
    });
  }
  const stored = await insertFindings(t.db, id, run.id, opts.findings);
  await transitionRun(t.db, id, run.id, opts.status ?? "completed", { at: at(opts.day) });
  return { run, stored };
}

const f = (o: Partial<NewFinding>) => sampleFinding(o);

beforeAll(async () => {
  t = await createTestDatabase();
  A = await createTenant(t.db, "alpha");
  B = await createTenant(t.db, "beta");
}, 30_000);
afterAll(async () => {
  await t.drop();
});

describe("listFindingsWithRuns", () => {
  let run1: Awaited<ReturnType<typeof review>>;
  let run2: Awaited<ReturnType<typeof review>>;
  let foreign: Awaited<ReturnType<typeof review>>;

  beforeAll(async () => {
    run1 = await review(A, {
      pr: 11,
      sha: "e1",
      day: 1,
      findings: [
        f({
          severity: "critical",
          category: "security",
          agent: "security",
          filePath: "src/auth/login.ts",
          posted: true,
        }),
        f({ severity: "low", category: "maintainability", filePath: "lib/util_helpers.ts" }),
        f({
          severity: "medium",
          filePath: "src/100%/done.ts",
          suppressedReason: "below_threshold",
        }),
      ],
    });
    run2 = await review(A, {
      repo: A.repo2,
      pr: 12,
      sha: "e2",
      day: 3,
      findings: [
        f({
          severity: "high",
          category: "test_gap",
          agent: "test_coverage",
          filePath: "src/auth/session.ts",
          posted: true,
        }),
        f({ severity: "info", category: "performance", filePath: null as unknown as undefined }),
      ],
    });
    foreign = await review(B, {
      pr: 1,
      sha: "x1",
      day: 2,
      findings: [f({ severity: "high", posted: true })],
    });
  });

  const ids = () => [A.installation.id];
  const titles = async (filters: Parameters<typeof listFindingsWithRuns>[2]) =>
    (await listFindingsWithRuns(t.db, ids(), filters)).items.map((r) => r.finding.title);

  it("lists reported findings, newest run first, with their run", async () => {
    const page = await listFindingsWithRuns(t.db, ids(), {});
    // Run 1 reported two findings (the third was suppressed), run 2 reported both of its findings.
    expect(page.items).toHaveLength(4);
    expect(page.items.map((r) => r.run.id)).toEqual([
      run2.run.id,
      run2.run.id,
      run1.run.id,
      run1.run.id,
    ]);
    expect(page.items[0]!.run).toMatchObject({ prNumber: 12, repoId: A.repo2.id });
    expect(page.items.every((r) => r.finding.suppressedReason === null)).toBe(true);
  });

  it("never lists another tenant's findings", async () => {
    const page = await listFindingsWithRuns(t.db, ids(), { status: "all" });
    expect(page.items.map((r) => r.run.id)).not.toContain(foreign.run.id);
    const theirs = await listFindingsWithRuns(t.db, [B.installation.id], {});
    expect(theirs.items.map((r) => r.run.id)).toEqual([foreign.run.id]);
  });

  it("filters by severity, category and agent", async () => {
    expect(await titles({ severity: "critical" })).toEqual([run1.stored[0]!.title]);
    expect(await titles({ category: "test_gap" })).toEqual([run2.stored[0]!.title]);
    expect(await titles({ agent: "security" })).toEqual([run1.stored[0]!.title]);
    expect(await titles({ severity: "critical", agent: "test_coverage" })).toEqual([]);
  });

  it("filters by status: posted, summary only, suppressed, all", async () => {
    expect((await titles({ status: "posted" })).sort()).toEqual(
      [run1.stored[0]!.title, run2.stored[0]!.title].sort(),
    );
    expect((await titles({ status: "summary_only" })).sort()).toEqual(
      [run1.stored[1]!.title, run2.stored[1]!.title].sort(),
    );
    expect(await titles({ status: "suppressed" })).toEqual([run1.stored[2]!.title]);
    expect(await titles({ status: "all" })).toHaveLength(5);
  });

  it("searches the file path, case-insensitively, taking wildcards literally", async () => {
    expect(await titles({ path: "AUTH/" })).toHaveLength(2);
    expect(await titles({ path: "src/auth/session" })).toEqual([run2.stored[0]!.title]);
    // `_` and `%` are not wildcards: "util_helpers" matches itself, "util-helpers" and "u%" match nothing.
    expect(await titles({ path: "util_helpers" })).toEqual([run1.stored[1]!.title]);
    expect(await titles({ path: "util%helpers" })).toEqual([]);
    expect(await titles({ path: "%" })).toEqual([]);
    expect(await titles({ path: "100%", status: "all" })).toEqual([run1.stored[2]!.title]);
  });

  it("filters by the time the run was queued (inclusive)", async () => {
    expect(await titles({ from: at(2) })).toHaveLength(2);
    expect(await titles({ to: at(2) })).toHaveLength(2);
    expect(await titles({ from: at(1), to: at(1) })).toHaveLength(2);
    expect(await titles({ from: at(5) })).toEqual([]);
  });

  it("limits to the given repositories and run", async () => {
    expect(await titles({ repoIds: [A.repo2.id] })).toHaveLength(2);
    expect(await titles({ repoIds: [] })).toEqual([]);
    expect(await titles({ repoIds: [B.repo.id] })).toEqual([]);
    expect(await titles({ runId: run1.run.id })).toHaveLength(2);
    expect(await titles({ runId: "not-a-uuid" })).toEqual([]);
  });

  it("pages in a stable order without gaps or repeats", async () => {
    const seen: string[] = [];
    let cursor: string | undefined;
    do {
      const page = await listFindingsWithRuns(t.db, ids(), {
        status: "all",
        limit: 2,
        ...(cursor ? { cursor } : {}),
      });
      expect(page.items.length).toBeLessThanOrEqual(2);
      seen.push(...page.items.map((r) => r.finding.id));
      cursor = page.nextCursor ?? undefined;
    } while (cursor);
    expect(seen).toHaveLength(5);
    expect(new Set(seen).size).toBe(5);
  });

  it("gets one finding with its run, or nothing outside the scope", async () => {
    const one = await getFindingWithRun(t.db, ids(), run1.stored[0]!.id);
    expect(one?.run.prNumber).toBe(11);
    expect(await getFindingWithRun(t.db, [B.installation.id], run1.stored[0]!.id)).toBeUndefined();
    expect(await getFindingWithRun(t.db, ids(), "nope")).toBeUndefined();
  });
});

describe("summarizeFeedback", () => {
  it("counts votes per finding and reports the caller's own", async () => {
    const { stored } = await review(A, {
      pr: 21,
      sha: "fb",
      day: 4,
      findings: [f({ posted: true }), f({ posted: true }), f({ posted: true })],
    });
    const other = await upsertUser(t.db, { githubUserId: 32_000_001, login: "voter-two" });
    const id = A.installation.id;
    await setFeedback(t.db, id, {
      findingId: stored[0]!.id,
      userId: A.user.id,
      verdict: "useful",
      note: "Good catch",
    });
    await setFeedback(t.db, id, {
      findingId: stored[0]!.id,
      userId: other.id,
      verdict: "false_positive",
    });
    await setFeedback(t.db, id, { findingId: stored[1]!.id, userId: other.id, verdict: "known" });

    const summary = await summarizeFeedback(
      t.db,
      [id],
      stored.map((s) => s.id),
      A.user.id,
    );
    expect(summary.get(stored[0]!.id)).toEqual({
      useful: 1,
      false_positive: 1,
      known: 0,
      mine: { verdict: "useful", note: "Good catch" },
    });
    expect(summary.get(stored[1]!.id)).toEqual({
      useful: 0,
      false_positive: 0,
      known: 1,
      mine: null,
    });
    // A finding nobody voted on still has an entry.
    expect(summary.get(stored[2]!.id)).toEqual({
      useful: 0,
      false_positive: 0,
      known: 0,
      mine: null,
    });

    // One vote per user: voting again replaces it.
    await setFeedback(t.db, id, { findingId: stored[0]!.id, userId: A.user.id, verdict: "known" });
    const again = await summarizeFeedback(t.db, [id], [stored[0]!.id], A.user.id);
    expect(again.get(stored[0]!.id)).toEqual({
      useful: 0,
      false_positive: 1,
      known: 1,
      mine: { verdict: "known", note: null },
    });
  });

  it("does not count another installation's votes", async () => {
    const { stored } = await review(A, {
      pr: 22,
      sha: "fc",
      day: 4,
      findings: [f({ posted: true })],
    });
    await setFeedback(t.db, A.installation.id, {
      findingId: stored[0]!.id,
      userId: A.user.id,
      verdict: "useful",
    });
    const other = await summarizeFeedback(t.db, [B.installation.id], [stored[0]!.id], A.user.id);
    expect(other.get(stored[0]!.id)).toEqual({
      useful: 0,
      false_positive: 0,
      known: 0,
      mine: null,
    });
  });
});

describe("findInlineCommentIds", () => {
  it("maps run and fingerprint to the GitHub comment, for inline comments only", async () => {
    const id = A.installation.id;
    const { run, stored } = await review(A, {
      pr: 31,
      sha: "cc",
      day: 5,
      findings: [f({ posted: true }), f({})],
    });
    await recordPostedComment(t.db, id, run.id, {
      kind: "review_comment",
      githubId: 4242,
      fingerprint: stored[0]!.fingerprint,
      headSha: run.headSha,
    });
    await recordPostedComment(t.db, id, run.id, {
      kind: "summary",
      githubId: 9999,
      headSha: run.headSha,
    });

    const keys = stored.map((s) => ({ runId: run.id, fingerprint: s.fingerprint }));
    const map = await findInlineCommentIds(t.db, [id], keys);
    expect([...map.entries()]).toEqual([[`${run.id}:${stored[0]!.fingerprint}`, 4242]]);
    expect((await findInlineCommentIds(t.db, [B.installation.id], keys)).size).toBe(0);
  });
});

describe("listPullHistory", () => {
  it("returns the runs of one pull request oldest first with reported findings and agent outcomes", async () => {
    const first = await review(A, {
      pr: 41,
      sha: "h1",
      day: 6,
      findings: [f({ posted: true }), f({ suppressedReason: "style_only" })],
    });
    const second = await review(A, {
      pr: 41,
      sha: "h2",
      day: 7,
      status: "partial",
      agents: [
        ["code_review", "ok"],
        ["security", "timeout"],
      ],
      findings: [],
    });
    await review(A, { pr: 42, sha: "z", day: 7, findings: [f({})] });

    const history = await listPullHistory(t.db, [A.installation.id], A.repo.id, 41);
    expect(history.truncated).toBe(false);
    expect(history.runs.map((r) => r.run.id)).toEqual([first.run.id, second.run.id]);
    expect(history.runs[0]!.findings).toHaveLength(1);
    expect(history.runs[1]!.agents).toEqual(
      expect.arrayContaining([
        { agent: "code_review", status: "ok" },
        { agent: "security", status: "timeout" },
      ]),
    );
  });

  it("keeps the latest runs and says so when there are more", async () => {
    for (let i = 0; i < 4; i += 1)
      await review(A, { pr: 51, sha: `p${i}`, day: 8 + i, findings: [] });
    const history = await listPullHistory(t.db, [A.installation.id], A.repo.id, 51, 3);
    expect(history.truncated).toBe(true);
    expect(history.runs.map((r) => r.run.headSha.slice(0, 2))).toEqual(["p1", "p2", "p3"]);
  });

  it("is empty for another tenant, an unknown pull request or a malformed id", async () => {
    expect((await listPullHistory(t.db, [B.installation.id], A.repo.id, 41)).runs).toEqual([]);
    expect((await listPullHistory(t.db, [A.installation.id], A.repo.id, 9999)).runs).toEqual([]);
    expect((await listPullHistory(t.db, [A.installation.id], "nope", 41)).runs).toEqual([]);
  });
});

describe("listAuditEntries", () => {
  it("lists one installation's entries newest first with the person's login", async () => {
    const id = A.installation.id;
    await appendAuditLog(t.db, id, {
      userId: A.user.id,
      action: "settings.update",
      target: "repo:1",
      at: at(20),
    });
    await appendAuditLog(t.db, id, {
      userId: A.user.id,
      action: "run.rerun",
      target: "run:1",
      at: at(21),
    });
    await appendAuditLog(t.db, id, { action: "run.cancel", target: "run:2", at: at(22) });
    await appendAuditLog(t.db, B.installation.id, {
      action: "run.rerun",
      target: "run:3",
      at: at(23),
    });

    const all = await listAuditEntries(t.db, [id, B.installation.id], { installationId: id });
    expect(all.items.map((e) => e.entry.action)).toEqual([
      "run.cancel",
      "run.rerun",
      "settings.update",
    ]);
    expect(all.items.map((e) => e.userLogin)).toEqual([null, A.user.login, A.user.login]);

    const some = await listAuditEntries(t.db, [id], { installationId: id, action: "run.rerun" });
    expect(some.items).toHaveLength(1);

    const paged = await listAuditEntries(t.db, [id], { installationId: id, limit: 2 });
    expect(paged.items).toHaveLength(2);
    expect(paged.nextCursor).not.toBeNull();
    const rest = await listAuditEntries(t.db, [id], {
      installationId: id,
      limit: 2,
      cursor: paged.nextCursor!,
    });
    expect(rest.items.map((e) => e.entry.action)).toEqual(["settings.update"]);

    // Naming an installation the caller cannot reach lists nothing.
    expect(
      (await listAuditEntries(t.db, [id], { installationId: B.installation.id })).items,
    ).toEqual([]);
  });
});
