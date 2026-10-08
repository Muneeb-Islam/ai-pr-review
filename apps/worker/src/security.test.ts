// Phase 12 inside the worker: the Security agent's findings are stored as `security` findings, the summary and the
// Check Run give the overall security status (AC-7), and nothing sensitive reaches the database or GitHub (FR-29).
// Real PostgreSQL, scripted model, in-memory GitHub.
import { listAgentRuns, listFindingsForRun, updateRunDetails } from "@ai-pr-review/db";
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

let t: TestDatabase;
beforeAll(async () => {
  t = await createTestDatabase();
}, 60_000);
afterAll(async () => {
  await t.drop();
});

const CHECK_ID = 778;
/** Credential-shaped, and not one of the token formats the context redaction knows. */
const SECRET = ["Zk3pQ9xV7mLw", "2RtB8nYd4HsC", "6JfA1eUg"].join("");

// The fake PR adds lines 1-3 of src/a.ts.
const critical = (over: Record<string, unknown> = {}) =>
  modelFinding({
    category: "security",
    severity: "critical",
    confidence: 0.96,
    title: "Hard-coded payment API secret",
    file_path: "src/a.ts",
    start_line: 2,
    end_line: 2,
    evidence: `const apiSecret = "${SECRET}";`,
    impact: `The key ${SECRET} gives access to the payment account; ' OR 1=1 -- is not needed.`,
    recommendation: "Rotate the secret and read it from the environment.",
    ...over,
  });

const SECURITY_ONLY = { agents: { code_review: false, test_coverage: false, security: true } };

async function runWithCheck(label: string) {
  const tenant = await readyTenant(t, label, SECURITY_ONLY);
  const run = await queuedRun(t, tenant);
  await updateRunDetails(t.db, tenant.installation.id, run.id, { checkRunId: CHECK_ID });
  return { tenant, run };
}

const publishing = () =>
  createFakePublisherGitHub({
    headSha: HEAD_SHA,
    appLogin: APP_LOGIN,
    checkRuns: [{ id: CHECK_ID, status: "queued" }],
  });

describe("security in the run lifecycle", () => {
  it("stores the finding, calls it out in the summary and the Check Run, and keeps the secret out of everything (AC-7, FR-29)", async () => {
    const { tenant, run } = await runWithCheck("critical");
    const out = publishing();
    const rig = buildRig(t, {
      github: fakeGitHub({ tree: [{ path: "package.json" }] }),
      replies: [answer(critical())],
      deps: { publisher: realPublisher(t, out), appLogin: APP_LOGIN },
    });

    expect(await rig.processor.process(run.id)).toMatchObject({
      kind: "finished",
      status: "completed",
    });

    const ids = [tenant.installation.id];
    expect((await listAgentRuns(t.db, ids, run.id)).map((a) => [a.agent, a.status])).toEqual([
      ["security", "ok"],
    ]);
    const [finding] = await listFindingsForRun(t.db, ids, run.id);
    expect(finding).toMatchObject({
      agent: "security",
      category: "security",
      severity: "critical",
      posted: true,
    });
    for (const text of [
      finding!.title,
      finding!.evidence,
      finding!.impact,
      finding!.recommendation,
    ]) {
      expect(text).not.toContain(SECRET);
      expect(text).not.toMatch(/or 1=1/i);
    }
    expect(finding!.evidence).toBe('const apiSecret = "[REDACTED:credential]";');

    const summary = out.state.issueComments[0]!.body;
    expect(summary).toContain("### Security");
    expect(summary).toContain("**Attention needed: 1 critical security finding.**");
    expect(summary).toContain("not a replacement for SAST or dependency scanning");
    expect(summary).toContain("| Security | Done |");

    const check = out.state.checkRuns[0]!;
    expect(check.output?.title).toBe("1 finding: 1 critical (security attention needed)");
    expect(check.output?.summary).toContain(
      "**Security:** Attention needed: 1 critical security finding.",
    );

    const everything = [
      summary,
      check.output?.title ?? "",
      check.output?.summary ?? "",
      ...out.state.reviews.flatMap((r) => r.comments.map((c) => c.body)),
    ].join("\n");
    expect(everything).not.toContain(SECRET);
    expect(everything).not.toMatch(/or 1=1/i);
  });

  it("reports a clean security review as such, and a failed one as incomplete", async () => {
    const clean = await runWithCheck("clean");
    const out = publishing();
    await buildRig(t, {
      github: fakeGitHub({ tree: [{ path: "package.json" }] }),
      replies: [answer()],
      deps: { publisher: realPublisher(t, out), appLogin: APP_LOGIN },
    }).processor.process(clean.run.id);
    expect(out.state.issueComments[0]!.body).toContain("No security findings reported.");
    expect(out.state.checkRuns[0]!.output?.summary).toContain(
      "**Security:** No security findings reported.",
    );

    const broken = await runWithCheck("broken");
    const out2 = publishing();
    await buildRig(t, {
      github: fakeGitHub({ tree: [{ path: "package.json" }] }),
      replies: [new Error("provider down")],
      deps: { publisher: realPublisher(t, out2), appLogin: APP_LOGIN },
    }).processor.process(broken.run.id);
    expect(out2.state.checkRuns[0]!.output?.summary ?? "").not.toContain("No security findings");
  });
});
