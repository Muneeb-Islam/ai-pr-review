// AC-12: `fail_on_threshold` fails the Check Run only when a finding meets BOTH the severity and the confidence
// threshold; `warn` makes it neutral; `comment_only` never fails because of a finding; a run that did not finish
// never fails the check. Two levels: the full matrix of the conclusion rule, and the same decision made by the real
// worker and publisher against PostgreSQL and an in-memory GitHub.
import { checkConclusion, type EnforcementPolicy } from "@ai-pr-review/core";
import { answer, makeFinding, modelFinding } from "@ai-pr-review/core/testing";
import { updateRunDetails } from "@ai-pr-review/db";
import { createTestDatabase, type TestDatabase } from "@ai-pr-review/db/testing";
import type { Finding, RunStatus } from "@ai-pr-review/shared";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  APP_LOGIN,
  buildRig,
  createFakePublisherGitHub,
  HEAD_SHA,
  queuedRun,
  readyTenant,
  realPublisher,
} from "../apps/worker/src/testing";

const MODES = ["comment_only", "warn", "fail_on_threshold"] as const;
const policy = (mode: (typeof MODES)[number]): EnforcementPolicy => ({
  mode,
  minimumSeverity: "medium",
  minimumConfidence: 0.8,
});

const f = (over: Partial<Finding>): Finding => makeFinding({ id: "1".repeat(16), ...over });

// What each case holds, and what the check says in each mode.
const CASES: Array<{
  name: string;
  status: RunStatus;
  findings: Finding[];
  expected: Record<(typeof MODES)[number], string>;
}> = [
  {
    name: "no findings",
    status: "completed",
    findings: [],
    expected: { comment_only: "success", warn: "success", fail_on_threshold: "success" },
  },
  {
    name: "a low-severity finding (below the severity threshold)",
    status: "completed",
    findings: [f({ severity: "low", confidence: 0.95 })],
    expected: { comment_only: "success", warn: "success", fail_on_threshold: "success" },
  },
  {
    name: "a high-severity finding below the confidence threshold",
    status: "completed",
    findings: [f({ severity: "high", confidence: 0.6 })],
    expected: { comment_only: "success", warn: "success", fail_on_threshold: "success" },
  },
  {
    name: "a finding exactly at both thresholds",
    status: "completed",
    findings: [f({ severity: "medium", confidence: 0.8 })],
    expected: { comment_only: "success", warn: "neutral", fail_on_threshold: "failure" },
  },
  {
    name: "a high-severity, high-confidence finding",
    status: "completed",
    findings: [f({ severity: "high", confidence: 0.95 })],
    expected: { comment_only: "success", warn: "neutral", fail_on_threshold: "failure" },
  },
  {
    name: "a critical finding in a partial review",
    status: "partial",
    findings: [f({ severity: "critical", confidence: 0.95 })],
    expected: { comment_only: "neutral", warn: "neutral", fail_on_threshold: "failure" },
  },
  {
    name: "a missing test (never what stops a merge)",
    status: "completed",
    findings: [f({ category: "test_gap", severity: "high", confidence: 0.95 })],
    expected: { comment_only: "success", warn: "success", fail_on_threshold: "success" },
  },
  {
    name: "a failed run (an outage must not block a merge)",
    status: "failed",
    findings: [],
    expected: { comment_only: "neutral", warn: "neutral", fail_on_threshold: "neutral" },
  },
  {
    name: "a skipped run",
    status: "skipped",
    findings: [],
    expected: { comment_only: "neutral", warn: "neutral", fail_on_threshold: "neutral" },
  },
  {
    name: "a superseded run",
    status: "superseded",
    findings: [],
    expected: { comment_only: "neutral", warn: "neutral", fail_on_threshold: "neutral" },
  },
  {
    name: "a cancelled run",
    status: "cancelled",
    findings: [],
    expected: { comment_only: "neutral", warn: "neutral", fail_on_threshold: "neutral" },
  },
];

describe("the conclusion rule, mode by mode (AC-12)", () => {
  for (const c of CASES) {
    for (const mode of MODES) {
      it(`${mode}: ${c.name} -> ${c.expected[mode]}`, () => {
        expect(
          checkConclusion({
            status: c.status,
            findings: c.findings,
            degraded: false,
            policy: policy(mode),
          }),
        ).toBe(c.expected[mode]);
      });
    }
  }

  it("a repository without a policy behaves as comment_only", () => {
    expect(
      checkConclusion({
        status: "completed",
        findings: [f({ severity: "critical", confidence: 1 })],
        degraded: false,
      }),
    ).toBe("success");
  });

  it("comments that could not be posted make a completed review neutral, never a failure", () => {
    expect(
      checkConclusion({
        status: "completed",
        findings: [],
        degraded: true,
        policy: policy("fail_on_threshold"),
      }),
    ).toBe("neutral");
  });
});

describe("the same decision through the worker and the publisher (AC-12)", () => {
  let t: TestDatabase;
  beforeAll(async () => {
    t = await createTestDatabase();
  }, 60_000);
  afterAll(async () => {
    await t.drop();
  });

  /** One review of one pull request in the given mode, with what the model said; returns the Check Run as GitHub has it. */
  async function review(
    mode: (typeof MODES)[number],
    reply: ReturnType<typeof answer>,
    pr: number,
  ) {
    const tenant = await readyTenant(t, `${mode}-${pr}`, { review: { mode } });
    const run = await queuedRun(t, tenant, pr);
    const checkId = 900 + pr;
    await updateRunDetails(t.db, tenant.installation.id, run.id, { checkRunId: checkId });
    const github = createFakePublisherGitHub({
      headSha: HEAD_SHA,
      appLogin: APP_LOGIN,
      checkRuns: [{ id: checkId, status: "queued" }],
    });
    const rig = buildRig(t, {
      replies: [reply],
      deps: { publisher: realPublisher(t, github), appLogin: APP_LOGIN },
    });
    const outcome = await rig.processor.process(run.id);
    expect(outcome).toMatchObject({ kind: "finished", status: "completed" });
    return github.state.checkRuns[0]!;
  }

  const bug = (over: Record<string, unknown> = {}) =>
    answer(
      modelFinding({
        title: "Off-by-one",
        file_path: "src/a.ts",
        start_line: 2,
        end_line: 2,
        ...over,
      }),
    );

  let pr = 100;
  it("a finding at the thresholds: comment_only succeeds, warn is neutral, fail_on_threshold fails", async () => {
    const conclusions: Record<string, string | undefined> = {};
    for (const mode of MODES) conclusions[mode] = (await review(mode, bug(), ++pr)).conclusion;
    expect(conclusions).toEqual({
      comment_only: "success",
      warn: "neutral",
      fail_on_threshold: "failure",
    });
  });

  it("a failing check says why, and that it blocks a merge only if the repository requires it", async () => {
    const check = await review("fail_on_threshold", bug(), ++pr);
    expect(check.output?.title).toContain("fails the check");
    expect(check.output?.summary).toContain("blocks merging only if the repository requires it");
  });

  it("findings below either threshold never fail the check", async () => {
    for (const reply of [
      bug({ confidence: 0.5 }),
      bug({ severity: "low", confidence: 0.95 }),
      answer(),
    ]) {
      const check = await review("fail_on_threshold", reply, ++pr);
      expect(check.conclusion).toBe("success");
    }
  });
});
