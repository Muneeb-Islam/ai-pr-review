// Phase 9 end to end inside the worker: a queued run goes through the real processor and the real publisher
// against PostgreSQL and an in-memory GitHub that remembers what it was sent. The M1 behaviour of the slice:
// the Check Run moves queued -> in progress -> completed, the review, summary and Check Run reach the PR, and
// everything posted is recorded (AC-1 to AC-4, AC-16 at the data level).
import { file, manyFiles } from "@ai-pr-review/core/testing";
import {
  createRunSupersedingOlder,
  setRepositoryEnabled,
  listFindingsForRun,
  listPostedComments,
  updateRunDetails,
} from "@ai-pr-review/db";
import { claimRun, getRunById } from "@ai-pr-review/db/system";
import { createTenant, createTestDatabase, type TestDatabase } from "@ai-pr-review/db/testing";
import { hasSummaryMarker, parseFingerprintMarker } from "@ai-pr-review/core";
import { InMemoryRunSignals } from "@ai-pr-review/queue";
import { createLogger, type JobQueue } from "@ai-pr-review/shared";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Sweeper } from "./sweeper";
import {
  APP_LOGIN,
  bugAnswer,
  buildRig,
  configure,
  createFakePublisherGitHub,
  DASHBOARD_URL,
  fakeGitHub,
  HEAD_SHA,
  queuedRun,
  readyTenant,
  realPublisher,
  type FakePublisherSetup,
} from "./testing";

let t: TestDatabase;
beforeAll(async () => {
  t = await createTestDatabase();
}, 60_000);
afterAll(async () => {
  await t.drop();
});

const CHECK_ID = 555;

/** A run whose queued Check Run exists on GitHub, as the api creates it (Phase 3). */
async function runWithCheck(label: string, pr = 7) {
  const tenant = await readyTenant(t, label);
  const run = await queuedRun(t, tenant, pr);
  await updateRunDetails(t.db, tenant.installation.id, run.id, { checkRunId: CHECK_ID });
  return { tenant, run };
}

function setup(over: FakePublisherSetup = {}) {
  const out = createFakePublisherGitHub({
    headSha: HEAD_SHA,
    appLogin: APP_LOGIN,
    checkRuns: [{ id: CHECK_ID, status: "queued" }],
    ...over,
  });
  return {
    out,
    publishRig: (rigOptions: Parameters<typeof buildRig>[1] = {}) =>
      buildRig(t, {
        ...rigOptions,
        deps: { publisher: realPublisher(t, out), appLogin: APP_LOGIN, ...rigOptions.deps },
      }),
  };
}

/** The statuses the Check Run was given, in order. */
const checkStatuses = (calls: Array<{ route: string; params: Record<string, unknown> }>) =>
  calls
    .filter((c) => c.route.includes("check-runs"))
    .map((c) => `${c.route.split(" ")[0]} ${String(c.params["status"])}`);

describe("the M1 slice: PR event -> review, summary and Check Run -> history", () => {
  it("completes the Check Run, posts one review and one summary, and records everything", async () => {
    const { tenant, run } = await runWithCheck("happy");
    const { out, publishRig } = setup();
    const rig = publishRig();

    const outcome = await rig.processor.process(run.id);
    expect(outcome).toMatchObject({ kind: "finished", status: "completed" });

    // AC-16: the Check Run went in_progress, then completed.
    expect(checkStatuses(out.calls)).toEqual(["PATCH in_progress", "PATCH completed"]);
    expect(out.state.checkRuns[0]).toMatchObject({
      id: CHECK_ID,
      status: "completed",
      conclusion: "success",
    });
    expect(out.state.checkRuns[0]!.output?.title).toBe("1 finding: 1 high");

    // AC-3: the high-confidence issue is one inline comment, in one review, event COMMENT.
    expect(out.state.reviews).toHaveLength(1);
    expect(out.state.reviews[0]).toMatchObject({ event: "COMMENT", commitId: HEAD_SHA });
    const inline = out.state.reviews[0]!.comments;
    expect(inline).toHaveLength(1);
    expect(inline[0]).toMatchObject({ path: "src/a.ts", line: 2 });
    expect(inline[0]!.body).toContain("Off-by-one in add");

    // AC-2: one summary with the hidden marker and a link to the run.
    expect(out.state.issueComments).toHaveLength(1);
    const summary = out.state.issueComments[0]!;
    expect(hasSummaryMarker(summary.body)).toBe(true);
    expect(summary.body).toContain(`${DASHBOARD_URL}/runs/${run.id}`);
    expect(summary.body).toContain("Off-by-one in add");

    // The database holds what was posted.
    const stored = (await getRunById(t.db, run.id))!;
    expect(stored.status).toBe("completed");
    expect(stored.checkRunId).toBe(CHECK_ID);
    expect(stored.summaryCommentId).toBe(summary.id);
    expect(stored.warnings).toEqual([]);

    const ids = [tenant.installation.id];
    const posted = await listPostedComments(t.db, ids, run.id);
    expect(posted.map((p) => p.kind).sort()).toEqual(["review_comment", "summary"]);
    const reviewComment = posted.find((p) => p.kind === "review_comment")!;
    expect(reviewComment.githubId).toBe(inline[0]!.id);
    expect(reviewComment.headSha).toBe(HEAD_SHA);
    expect(reviewComment.fingerprint).toBe(parseFingerprintMarker(inline[0]!.body)!.fingerprint);

    const findings = await listFindingsForRun(t.db, ids, run.id);
    expect(findings).toHaveLength(1);
    expect(findings[0]!.posted).toBe(true);
  });

  it("creates the Check Run when it could not be created at queue time, and stores its id", async () => {
    const tenant = await readyTenant(t, "nocheck");
    const run = await queuedRun(t, tenant, 8);
    const { out, publishRig } = setup({ checkRuns: [] });

    await publishRig().processor.process(run.id);

    expect(out.state.checkRuns).toHaveLength(1);
    expect(out.state.checkRuns[0]).toMatchObject({ status: "completed", conclusion: "success" });
    expect((await getRunById(t.db, run.id))!.checkRunId).toBe(out.state.checkRuns[0]!.id);
  });

  it("a review with no findings says so, and posts a summary but no review (AC-4)", async () => {
    const { run } = await runWithCheck("clean", 9);
    const { out, publishRig } = setup();
    await publishRig({ replies: [{ findings: [], observations: [] }] }).processor.process(run.id);

    expect(out.state.reviews).toHaveLength(0);
    expect(out.state.issueComments[0]!.body).toContain("No findings.");
    expect(out.state.checkRuns[0]).toMatchObject({ conclusion: "success" });
    expect(out.state.checkRuns[0]!.output?.title).toBe("No issues found");
  });

  it("gives a draft pull request the summary only (FR-05)", async () => {
    const { run } = await runWithCheck("draft", 11);
    const { out, publishRig } = setup();
    const rig = publishRig({ github: fakeGitHub({ pull: { headSha: HEAD_SHA, draft: true } }) });

    await rig.processor.process(run.id);

    expect(out.state.reviews).toHaveLength(0);
    expect(out.state.issueComments[0]!.body).toContain("Draft pull request");
    expect(out.state.issueComments[0]!.body).toContain("Off-by-one in add");
  });

  it("updates the same summary comment on a later run for the PR", async () => {
    const { tenant, run } = await runWithCheck("rerun", 12);
    const { out, publishRig } = setup();
    // The App's summary from the earlier run is on the PR; the context reads it as `prior`.
    const first = await publishRig().processor.process(run.id);
    expect(first.kind).toBe("finished");
    const summaryId = out.state.issueComments[0]!.id;

    const second = await queuedRun(t, tenant, 12);
    const github = fakeGitHub({
      issueComments: [{ id: summaryId, body: out.state.issueComments[0]!.body }],
    });
    await publishRig({ github }).processor.process(second.id);

    expect(out.state.issueComments).toHaveLength(1);
    expect((await getRunById(t.db, second.id))!.summaryCommentId).toBe(summaryId);
  });
});

describe("when GitHub refuses (design §13)", () => {
  it("403 on the review: the run still completes, with a warning, and the check is neutral", async () => {
    const { run } = await runWithCheck("denied", 13);
    const { out, publishRig } = setup({
      failures: { "POST /repos/{owner}/{repo}/pulls/{pull_number}/reviews": 403 },
    });

    const outcome = await publishRig().processor.process(run.id);

    expect(outcome).toMatchObject({ kind: "finished", status: "completed" });
    const stored = (await getRunById(t.db, run.id))!;
    expect(stored.warnings.join(" ")).toContain("Pull requests: write");
    expect(out.state.checkRuns[0]).toMatchObject({ status: "completed", conclusion: "neutral" });
    expect(out.state.issueComments).toHaveLength(1);
    const findings = await listFindingsForRun(t.db, [stored.installationId], run.id);
    expect(findings[0]!.posted).toBe(false);
  });

  it("403 on the Check Run is a warning on the run, not a failure", async () => {
    const { run } = await runWithCheck("checkdenied", 14);
    const { out, publishRig } = setup({
      failures: { "PATCH /repos/{owner}/{repo}/check-runs": 403 },
    });

    const outcome = await publishRig().processor.process(run.id);

    expect(outcome).toMatchObject({ kind: "finished", status: "completed" });
    expect((await getRunById(t.db, run.id))!.warnings.join(" ")).toContain("Checks: write");
    expect(out.state.reviews).toHaveLength(1);
  });

  it("422 on the review: the good comments are posted one by one, the rejected one goes to the summary", async () => {
    const { tenant, run } = await runWithCheck("rejected", 15);
    const { out, publishRig } = setup({ invalidPaths: ["src/b.ts"] });
    const bad = { ...bugAnswer("Bad anchor").findings[0]!, file_path: "src/b.ts" };
    const rig = publishRig({
      github: fakeGitHub({ files: [file("src/a.ts"), file("src/b.ts")] }),
      replies: [{ findings: [...bugAnswer().findings, bad], observations: [] }],
    });

    const outcome = await rig.processor.process(run.id);

    expect(outcome).toMatchObject({ kind: "finished", status: "completed" });
    expect(out.state.reviews).toHaveLength(0);
    expect(out.state.singleComments.map((c) => c.path)).toEqual(["src/a.ts"]);
    expect(out.state.issueComments[0]!.body).toContain("Bad anchor");
    const stored = (await getRunById(t.db, run.id))!;
    expect(stored.warnings.join(" ")).toContain("rejected 1 inline comment");
    expect(out.state.checkRuns[0]).toMatchObject({ conclusion: "neutral" });

    const posted = await listPostedComments(t.db, [tenant.installation.id], run.id);
    expect(posted.filter((p) => p.kind === "review_comment")).toHaveLength(1);
    const findings = await listFindingsForRun(t.db, [tenant.installation.id], run.id);
    expect(findings.map((f) => [f.title, f.posted]).sort()).toEqual([
      ["Bad anchor", false],
      ["Off-by-one in add", true],
    ]);
  });
});

describe("runs that never reach a review still close their Check Run", () => {
  it("a missing credential: failed with a clear reason, check neutral, no summary comment", async () => {
    const tenant = await createTenant(t.db, "nokey");
    await configure(t, tenant);
    const run = await queuedRun(t, tenant, 20);
    await updateRunDetails(t.db, tenant.installation.id, run.id, { checkRunId: CHECK_ID });
    const { out, publishRig } = setup();

    const outcome = await publishRig().processor.process(run.id);

    expect(outcome).toMatchObject({ kind: "finished", status: "failed" });
    expect(out.state.checkRuns[0]).toMatchObject({ status: "completed", conclusion: "neutral" });
    expect(out.state.checkRuns[0]!.output?.title).toBe("Review failed");
    expect(out.state.checkRuns[0]!.output?.summary).toContain("No API key is stored");
    expect(out.state.issueComments).toHaveLength(0);
    expect(out.state.reviews).toHaveLength(0);
  });

  it("a repository disabled while the run was queued: skipped, check neutral with the reason", async () => {
    const { tenant, run } = await runWithCheck("disabled", 21);
    await setRepositoryEnabled(t.db, tenant.installation.id, tenant.repo.id, false);
    const { out, publishRig } = setup();

    const outcome = await publishRig().processor.process(run.id);

    expect(outcome).toMatchObject({ kind: "finished", status: "skipped" });
    expect(out.state.checkRuns[0]).toMatchObject({ conclusion: "neutral" });
    expect(out.state.checkRuns[0]!.output?.summary).toContain("turned off");
  });

  it("a size-policy skip is explained in the summary and the check is neutral (FR-09)", async () => {
    const { run } = await runWithCheck("toolarge", 22);
    const { out, publishRig } = setup();
    const github = fakeGitHub({ files: manyFiles(300, 200) });

    const outcome = await publishRig({ github }).processor.process(run.id);

    expect(outcome).toMatchObject({ kind: "finished", status: "skipped" });
    expect(out.state.issueComments[0]!.body).toContain("**Status:** Skipped");
    expect(out.state.checkRuns[0]).toMatchObject({ conclusion: "neutral" });
    expect(out.state.reviews).toHaveLength(0);
  });

  it("a run superseded by the api before it started: the old Check Run is closed when its job arrives", async () => {
    const tenant = await readyTenant(t, "supersededq");
    const old = await queuedRun(t, tenant, 23);
    await updateRunDetails(t.db, tenant.installation.id, old.id, { checkRunId: CHECK_ID });
    // A newer head for the same PR supersedes it.
    await createRunSupersedingOlder(t.db, tenant.installation.id, {
      repoId: tenant.repo.id,
      prNumber: 23,
      headSha: "b".repeat(40),
      baseSha: "c".repeat(40),
      baseRef: "main",
      trigger: "pull_request",
    });
    const { out, publishRig } = setup();

    const outcome = await publishRig().processor.process(old.id);

    expect(outcome).toEqual({ kind: "not_queued" });
    expect(out.state.checkRuns[0]).toMatchObject({ status: "completed", conclusion: "neutral" });
    expect(out.state.checkRuns[0]!.output?.title).toBe("Superseded by a newer commit");
    expect(out.state.reviews).toHaveLength(0);
  });

  it("a run superseded while it is reviewing posts nothing and closes its own Check Run", async () => {
    const { tenant, run } = await runWithCheck("supersededrun", 25);
    const { out, publishRig } = setup();
    const rig = publishRig({
      deps: { heartbeatIntervalMs: 60_000 },
      replies: [
        async () => {
          // A newer push arrives while the model is thinking.
          await createRunSupersedingOlder(t.db, tenant.installation.id, {
            repoId: tenant.repo.id,
            prNumber: 25,
            headSha: "b".repeat(40),
            baseSha: "c".repeat(40),
            baseRef: "main",
            trigger: "pull_request",
          });
          return bugAnswer();
        },
      ],
    });

    const outcome = await rig.processor.process(run.id);

    expect(outcome).toEqual({ kind: "stopped", reason: "lost" });
    expect(out.state.reviews).toHaveLength(0);
    expect(out.state.issueComments).toHaveLength(0);
    expect(out.state.checkRuns[0]).toMatchObject({ status: "completed", conclusion: "neutral" });
    expect(out.state.checkRuns[0]!.output?.title).toBe("Superseded by a newer commit");
  });

  it("a pull request that moved while the review ran: nothing is posted and the run is superseded", async () => {
    const { run } = await runWithCheck("moved", 24);
    const { out, publishRig } = setup({ headSha: "f".repeat(40) }); // the publisher's re-read sees a new head

    const outcome = await publishRig().processor.process(run.id);

    expect(outcome).toMatchObject({ kind: "finished", status: "superseded" });
    expect(out.state.reviews).toHaveLength(0);
    expect(out.state.issueComments).toHaveLength(0);
    expect(out.state.checkRuns[0]).toMatchObject({ status: "completed", conclusion: "neutral" });
    expect((await getRunById(t.db, run.id))!.statusReason).toContain("moved to fffffff");
  });
});

describe("the sweeper", () => {
  it("closes the Check Run of a run it gives up on, so the PR does not wait for ever", async () => {
    const { run } = await runWithCheck("poison", 40);
    const claimed = (await claimRun(t.db, run.id, new Date(Date.now() - 3_600_000)))!;
    const { out } = setup();
    const queue = { enqueue: async () => undefined, maxAttempts: 3 } as unknown as JobQueue;
    const sweeper = new Sweeper({
      db: t.db,
      queue,
      signals: new InMemoryRunSignals(),
      logger: createLogger({}, () => undefined),
      publisher: realPublisher(t, out),
      staleAfterMs: 60_000,
      queuedGraceMs: 0,
      maxRunAttempts: claimed.attempts, // this was the last allowed attempt
    });

    expect(await sweeper.sweepOnce()).toMatchObject({ failed: 1 });

    expect((await getRunById(t.db, run.id))!.status).toBe("failed");
    expect(out.state.checkRuns[0]).toMatchObject({ status: "completed", conclusion: "neutral" });
    expect(out.state.checkRuns[0]!.output?.title).toBe("Review failed");
  });
});

describe("safety", () => {
  it("never posts a planted secret, and never logs it", async () => {
    const { run } = await runWithCheck("secret", 30);
    const { out, publishRig } = setup();
    const secret = `sk-${"proj1234567890abcdefghijkl"}`;
    const leaky = {
      ...bugAnswer().findings[0]!,
      title: `Hard-coded key ${secret}`,
      evidence: `const key = "${secret}"`,
      impact: `Anyone with the repo can use ${secret}.`,
    };
    const rig = publishRig({ replies: [{ findings: [leaky], observations: [] }] });

    await rig.processor.process(run.id);

    const everything = JSON.stringify([out.state, out.calls]);
    expect(everything).not.toContain(secret);
    for (const line of rig.logs) expect(line).not.toContain(secret);
  });
});
