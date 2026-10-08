// Phase 11 inside the worker: the Test Coverage agent reads the coverage artifact through the installation client,
// its measurement is stored on the run (`review_runs.coverage`), its suggestions are findings, and the summary and
// the Check Run say which is which (AC-5, AC-6). Real PostgreSQL, scripted model, in-memory GitHub.
import { lcovRecord, lcovZip } from "@ai-pr-review/core/testing";
import { listAgentRuns, listFindingsForRun, updateRunDetails } from "@ai-pr-review/db";
import { getRunById } from "@ai-pr-review/db/system";
import { createTestDatabase, type TestDatabase } from "@ai-pr-review/db/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  APP_LOGIN,
  answer,
  buildRig,
  createFakePublisherGitHub,
  fakeGitHub,
  HEAD_SHA,
  modelFinding,
  queuedRun,
  readyTenant,
  realPublisher,
} from "./testing";
import { toRunResults } from "./processor";

let t: TestDatabase;
beforeAll(async () => {
  t = await createTestDatabase();
}, 60_000);
afterAll(async () => {
  await t.drop();
});

const CHECK_ID = 777;

// The fake PR adds lines 1-3 of src/a.ts. The report runs line 1 and misses 2 and 3.
const REPORT = lcovRecord("src/a.ts", [
  [1, 5],
  [2, 0],
  [3, 0],
]);

const suggestion = answer(
  modelFinding({
    category: "test_gap",
    severity: "medium",
    confidence: 0.93,
    title: "Missing test: the sum of two numbers",
    file_path: "src/a.ts",
    start_line: 2,
    end_line: 2,
    evidence: "return a + b;",
    impact: "A change to the arithmetic would go unnoticed.",
    recommendation: "Add a test file next to it.",
    suggested_test: "Target: add. Scenario: two integers. Setup: add(2, 3). Assert: returns 5.",
  }),
);

const withArtifact = () =>
  fakeGitHub({
    tree: [{ path: "package.json" }],
    actions: {
      runs: [{ id: 31, status: "completed" }],
      artifacts: { 31: [{ id: 900, name: "coverage", size_in_bytes: 400 }] },
      zips: { 900: new Uint8Array(lcovZip(REPORT)) },
    },
  });

/** Only the Test Coverage agent, so each run is one model call and the findings are all its own. */
const COVERAGE_ONLY = { agents: { code_review: false, security: false, test_coverage: true } };

async function runWithCheck(label: string) {
  const tenant = await readyTenant(t, label, COVERAGE_ONLY);
  const run = await queuedRun(t, tenant);
  await updateRunDetails(t.db, tenant.installation.id, run.id, { checkRunId: CHECK_ID });
  return { tenant, run };
}

describe("coverage in the run lifecycle", () => {
  it("measures changed-line coverage from the artifact and stores it with the run (AC-6)", async () => {
    const { tenant, run } = await runWithCheck("measured");
    const gh = withArtifact();
    const out = createFakePublisherGitHub({
      headSha: HEAD_SHA,
      appLogin: APP_LOGIN,
      checkRuns: [{ id: CHECK_ID, status: "queued" }],
    });
    const rig = buildRig(t, {
      github: gh,
      replies: [suggestion],
      deps: { publisher: realPublisher(t, out), appLogin: APP_LOGIN },
    });

    const outcome = await rig.processor.process(run.id);
    expect(outcome).toMatchObject({ kind: "finished", status: "completed" });

    // The engine was handed the installation client, and used it for the Actions API only for this agent.
    const routes = gh.calls.map((c) => c.route);
    expect(routes).toContain("GET /repos/{owner}/{repo}/actions/runs");
    expect(routes).toContain(
      "GET /repos/{owner}/{repo}/actions/artifacts/{artifact_id}/{archive_format}",
    );

    const stored = (await getRunById(t.db, run.id))!;
    expect(stored.coverage).toMatchObject({
      status: "measured",
      coveredLines: 1,
      totalLines: 3,
      artifact: { name: "coverage", runId: 31 },
    });
    expect(stored.coverage?.changedLineCoverage).toBeCloseTo(1 / 3);
    expect(stored.coverage?.files?.[0]).toMatchObject({
      path: "src/a.ts",
      status: "measured",
      uncovered: [{ start: 2, end: 3 }],
    });

    const ids = [tenant.installation.id];
    expect((await listAgentRuns(t.db, ids, run.id)).map((a) => [a.agent, a.status])).toEqual([
      ["test_coverage", "ok"],
    ]);
    const findings = await listFindingsForRun(t.db, ids, run.id);
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({
      agent: "test_coverage",
      category: "test_gap",
      posted: true, // confidence 0.93, on an added line: an inline suggestion
    });
    expect(findings[0]!.suggestedTest).toContain("Scenario: two integers");

    // The summary keeps the measurement and the suggestion apart; the Check Run carries the number.
    const summary = out.state.issueComments[0]!.body;
    expect(summary).toContain(
      "**Measured: 33% of changed lines covered** (1 of 3 executable lines)",
    );
    expect(summary).toContain(
      "**Verified coverage deficiency** `src/a.ts`: 33% (1 of 3); lines not run: 2-3",
    );
    expect(summary).toContain("**Suggested missing test**");
    expect(out.state.checkRuns[0]!.output?.summary).toContain(
      "**Coverage:** 33% of changed lines (measured from the CI report).",
    );
    const inline = out.state.reviews[0]!.comments;
    expect(inline).toHaveLength(1);
    expect(inline[0]!.body).toContain("**Suggested missing test** — the sum of two numbers");
  });

  it("completes with coverage not available when CI uploaded nothing, and says so (AC-5)", async () => {
    const { tenant, run } = await runWithCheck("nocoverage");
    const out = createFakePublisherGitHub({
      headSha: HEAD_SHA,
      appLogin: APP_LOGIN,
      checkRuns: [{ id: CHECK_ID, status: "queued" }],
    });
    const gh = fakeGitHub({
      tree: [{ path: "package.json" }],
      actions: { runs: [{ id: 31, status: "in_progress" }], artifacts: { 31: [] } },
    });
    const rig = buildRig(t, {
      github: gh,
      replies: [suggestion],
      deps: { publisher: realPublisher(t, out), appLogin: APP_LOGIN },
    });

    const outcome = await rig.processor.process(run.id);
    expect(outcome).toMatchObject({ kind: "finished", status: "completed" });

    const stored = (await getRunById(t.db, run.id))!;
    expect(stored.coverage).toMatchObject({ status: "not_available", reasonCode: "ci_running" });
    expect(stored.coverage?.changedLineCoverage).toBeUndefined();
    expect(stored.warnings).toEqual([]); // an ordinary situation, not a problem with the run

    const summary = out.state.issueComments[0]!.body;
    expect(summary).toContain("**Coverage could not be measured.**");
    expect(summary).toContain("CI was still running");
    expect(summary).toContain("**Suggested missing test**");
    expect(summary).not.toMatch(/\d+% of changed lines/);
    expect(out.state.checkRuns[0]!.output?.summary).toContain("**Coverage:** not measured.");

    const findings = await listFindingsForRun(t.db, [tenant.installation.id], run.id);
    expect(findings).toHaveLength(1);
  });

  it("does not fail the run when GitHub's Actions API misbehaves", async () => {
    const { run } = await runWithCheck("actionsdown");
    const gh = fakeGitHub({
      tree: [{ path: "package.json" }],
      failures: { "GET /repos/{owner}/{repo}/actions/runs": 502 },
      actions: { runs: [] },
    });
    const rig = buildRig(t, { github: gh, replies: [suggestion] });

    const outcome = await rig.processor.process(run.id);
    expect(outcome).toMatchObject({ kind: "finished", status: "completed" });
    expect((await getRunById(t.db, run.id))!.coverage).toMatchObject({
      status: "not_available",
      reasonCode: "github_error",
    });
  });

  it("leaves coverage empty when the agent is switched off", async () => {
    const tenant = await readyTenant(t, "agentoff"); // the helper turns Test Coverage off by default
    const run = await queuedRun(t, tenant);
    const rig = buildRig(t);
    await rig.processor.process(run.id);
    expect((await getRunById(t.db, run.id))!.coverage).toBeNull();
  });
});

describe("toRunResults", () => {
  it("carries the coverage only when the engine produced it", async () => {
    const empty = { skippedFiles: [], warnings: [] } as never;
    const base = {
      status: "completed",
      findings: [],
      suppressed: [],
      agentRuns: [],
      warnings: [],
      governor: { usage: { inputTokens: 0, outputTokens: 0 } },
    } as never;
    expect(toRunResults(empty, base)).not.toHaveProperty("coverage");
    const withCoverage = {
      ...(base as object),
      coverage: { status: "skipped", observations: [] },
    } as never;
    expect(toRunResults(empty, withCoverage).coverage).toEqual({
      status: "skipped",
      observations: [],
    });
  });
});
