import type { Finding } from "@ai-pr-review/shared";
import { describe, expect, it } from "vitest";
import type { EngineResult } from "../agents/types";
import { buildContext, HEAD_SHA, makeFinding } from "../agents/test-support";
import { fingerprintMarker, hasSummaryMarker, parseFingerprintMarker } from "../context/markers";
import { FAKE, file } from "../context/test-support";
import type { ReviewContext } from "../context/types";
import { publishReview, type PublishReport } from "./publish";
import { createFakePublisherGitHub, type FakePublisherSetup } from "./test-support";

const REPO = { owner: "acme", repo: "widgets" };

/** Two files of three added lines: lines 1-3 of each are in the diff. */
const files = () => [file("src/a.ts"), file("src/b.ts"), file("src/c.ts")];

const fp = (n: number) => n.toString(16).padStart(16, "0");

const finding = (n: number, over: Partial<Finding> = {}): Finding =>
  makeFinding({
    id: fp(n),
    title: `Problem ${n}`,
    filePath: "src/a.ts",
    startLine: 2,
    endLine: 2,
    ...over,
  });

function result(findings: Finding[], over: Partial<EngineResult> = {}): EngineResult {
  return {
    status: "completed",
    findings,
    suppressed: [],
    suppressedCounts: {
      below_threshold: 0,
      invalid_line: 0,
      no_evidence: 0,
      duplicate: 0,
      style_only: 0,
      rejected_by_final_review: 0,
    },
    agentRuns: [
      {
        agent: "code_review",
        status: "ok",
        durationMs: 5,
        usage: { inputTokens: 1, outputTokens: 1 },
        retries: 0,
        warnings: [],
      },
    ],
    observations: [],
    warnings: [],
    usage: { inputTokens: 1, outputTokens: 1 },
    governor: {
      requests: 1,
      usage: { inputTokens: 1, outputTokens: 1 },
    } as EngineResult["governor"],
    durationMs: 5,
    ...over,
  };
}

async function run(
  findings: Finding[],
  options: {
    context?: ReviewContext;
    github?: FakePublisherSetup;
    result?: Partial<EngineResult>;
    postedFingerprints?: string[];
    stillCurrent?: () => Promise<boolean>;
    config?: Parameters<typeof buildContext>[1];
  } = {},
) {
  const context = options.context ?? (await buildContext(files(), options.config));
  const github = createFakePublisherGitHub({ headSha: HEAD_SHA, ...options.github });
  const report = await publishReview({
    client: github.client,
    repo: REPO,
    context,
    result: result(findings, options.result),
    dashboardUrl: "https://dash.example/runs/r1",
    postedFingerprints: new Set(options.postedFingerprints ?? []),
    stillCurrent: options.stillCurrent,
  });
  return { report, github, context };
}

const published = (report: PublishReport) => {
  if (report.kind !== "published") throw new Error(`expected published, got ${report.kind}`);
  return report;
};

describe("the inline review (FR-17, FR-18, FR-33, AC-3)", () => {
  it("posts every qualifying finding in ONE review with event COMMENT, pinned to the reviewed commit", async () => {
    const { report, github } = await run([
      finding(1),
      finding(2, { filePath: "src/b.ts", startLine: 3, endLine: 3 }),
    ]);

    expect(github.state.reviews).toHaveLength(1);
    const review = github.state.reviews[0]!;
    expect(review.event).toBe("COMMENT");
    expect(review.commitId).toBe(HEAD_SHA);
    expect(review.comments.map((c) => `${c.path}:${c.line}`)).toEqual(["src/a.ts:2", "src/b.ts:3"]);

    const post = github.calls.find((c) => c.route.endsWith("/reviews"))!;
    expect(post.params["comments"]).toEqual([
      expect.objectContaining({ path: "src/a.ts", line: 2, side: "RIGHT" }),
      expect.objectContaining({ path: "src/b.ts", line: 3, side: "RIGHT" }),
    ]);
    expect(JSON.stringify(post.params)).not.toMatch(/APPROVE|REQUEST_CHANGES/);

    const r = published(report);
    expect(r.inline.map((p) => p.finding.id)).toEqual([fp(1), fp(2)]);
    expect(r.inline.every((p) => typeof p.githubId === "number")).toBe(true);
    expect(r.degraded).toBe(false);
  });

  it("embeds the fingerprint marker in each comment and links the run", async () => {
    const { github } = await run([finding(1)]);
    const body = github.state.reviews[0]!.comments[0]!.body;
    expect(body.startsWith(fingerprintMarker(fp(1), HEAD_SHA))).toBe(true);
    expect(parseFingerprintMarker(body)).toEqual({ fingerprint: fp(1), headSha: HEAD_SHA });
    expect(body).toContain("Problem 1");
    expect(body).toContain("Code Review");
    expect(body).toContain("https://dash.example/runs/r1");
  });

  it("anchors a multi-line finding as a range when both ends are in the diff", async () => {
    const { github } = await run([finding(1, { startLine: 1, endLine: 3 })]);
    const post = github.calls.find((c) => c.route.endsWith("/reviews"))!;
    expect((post.params["comments"] as Array<Record<string, unknown>>)[0]).toMatchObject({
      start_line: 1,
      start_side: "RIGHT",
      line: 3,
    });
  });

  it("keeps lower items out of the inline review (AC-4) and lists them in the summary", async () => {
    const low = finding(2, { severity: "low", confidence: 0.95, title: "Minor one" });
    const unsure = finding(3, { severity: "high", confidence: 0.5, title: "Unsure one" });
    const { github } = await run([finding(1), low, unsure]);

    expect(github.state.reviews[0]!.comments).toHaveLength(1);
    const summary = github.state.issueComments[0]!.body;
    expect(summary).toContain("Minor one");
    expect(summary).toContain("Unsure one");
  });

  it("caps the inline comments at max_inline_comments, most severe first, the rest go to the summary", async () => {
    const findings = [
      finding(1, { severity: "critical", title: "First" }),
      finding(2, { severity: "high", title: "Second" }),
      finding(3, { severity: "medium", title: "Third" }),
    ];
    const { github } = await run(findings, {
      config: { config: { review: { max_inline_comments: 2 } } },
    });

    expect(github.state.reviews[0]!.comments).toHaveLength(2);
    const summary = github.state.issueComments[0]!.body;
    expect(summary).toContain("Third");
    expect(summary).toContain("inline comment limit");
  });

  it("gives a draft pull request the summary only (FR-05)", async () => {
    const { github, report } = await run([finding(1)], {
      config: { pull: { draft: true } },
    });
    expect(github.state.reviews).toHaveLength(0);
    expect(github.state.issueComments).toHaveLength(1);
    expect(github.state.issueComments[0]!.body).toContain("Draft pull request");
    expect(published(report).inline).toHaveLength(0);
  });

  it("posts nothing inline for general findings, file-level findings and test suggestions below high confidence", async () => {
    const { github } = await run([
      finding(1, {
        filePath: undefined,
        startLine: undefined,
        endLine: undefined,
        title: "General",
      }),
      finding(2, { startLine: undefined, endLine: undefined, title: "File level" }),
      finding(3, {
        category: "test_gap",
        agent: "test_coverage",
        confidence: 0.85,
        suggestedTest: "Cover the empty input",
        title: "Untested",
      }),
    ]);
    expect(github.state.reviews).toHaveLength(0);
    const summary = github.state.issueComments[0]!.body;
    expect(summary).toContain("General");
    expect(summary).toContain("File level");
    expect(summary).toContain("Suggested tests");
    expect(summary).toContain("**Suggested missing test**");
    expect(summary).toContain("They are not measured coverage.");
  });

  it("posts a test suggestion inline only when it is tied to a changed line at high confidence, labelled as a suggestion (AC-5)", async () => {
    const { github, report } = await run([
      finding(1, {
        category: "test_gap",
        agent: "test_coverage",
        confidence: 0.95,
        suggestedTest: "Target: add. Scenario: empty input. Setup: add([]). Assert: returns 0.",
        title: "Missing test: empty input",
      }),
    ]);
    expect(published(report).inline).toHaveLength(1);
    const comment = github.state.reviews[0]!.comments[0]!.body;
    expect(comment).toContain("**Suggested missing test** — empty input");
    expect(comment).toContain("**Test to add:** Target: add.");
    expect(comment).toContain("not measured coverage");
  });

  it("does not post a finding that was already posted for this head SHA, and says it is on the PR", async () => {
    const { github, report } = await run([finding(1), finding(2, { filePath: "src/b.ts" })], {
      postedFingerprints: [fp(1)],
    });
    expect(github.state.reviews[0]!.comments).toHaveLength(1);
    expect(published(report).alreadyPosted.map((f) => f.id)).toEqual([fp(1)]);
    expect(github.state.issueComments[0]!.body).toContain("Problem 1");
  });

  it("also uses the markers GitHub already holds for this head SHA", async () => {
    const context = await buildContext(files(), {
      setup: {
        reviewComments: [{ id: 5, body: fingerprintMarker(fp(1), HEAD_SHA), path: "src/a.ts" }],
      },
    });
    const { github } = await run([finding(1)], { context });
    expect(github.state.reviews).toHaveLength(0);
  });
});

describe("validation right before posting", () => {
  it("drops a comment whose line is not in the diff, counts it as suppressed and does not summarise it", async () => {
    const { github, report } = await run([
      finding(1),
      finding(2, { startLine: 99, endLine: 99, title: "Stale line" }),
      finding(3, { filePath: "src/gone.ts", title: "Stale file" }),
    ]);
    expect(github.state.reviews[0]!.comments.map((c) => c.path)).toEqual(["src/a.ts"]);
    const r = published(report);
    expect(r.invalidPosition.map((f) => f.id)).toEqual([fp(2), fp(3)]);
    expect(r.warnings.join(" ")).toContain("2 findings pointed at lines outside the diff");
    const summary = github.state.issueComments[0]!.body;
    expect(summary).not.toContain("Stale line");
    expect(summary).toContain("pointing at a line that is not in the diff");
  });

  it("posts nothing when the pull request moved to another commit (design §12)", async () => {
    const context = await buildContext(files());
    const github = createFakePublisherGitHub({ headSha: "f".repeat(40) });
    const report = await publishReview({
      client: github.client,
      repo: REPO,
      context,
      result: result([finding(1)]),
    });
    expect(report).toEqual({ kind: "stale", currentHeadSha: "f".repeat(40) });
    expect(github.state.reviews).toHaveLength(0);
    expect(github.state.issueComments).toHaveLength(0);
  });

  it("stops without writing when the run is no longer ours", async () => {
    const { report, github } = await run([finding(1)], { stillCurrent: async () => false });
    expect(report.kind).toBe("lost");
    expect(github.state.reviews).toHaveLength(0);
    expect(github.state.issueComments).toHaveLength(0);
  });
});

describe("GitHub errors never fail the run (FR-38, design §13)", () => {
  it("403 on the review: a warning, the summary still lands, the check will be neutral", async () => {
    const { report, github } = await run([finding(1)], {
      github: { failures: { "POST /repos/{owner}/{repo}/pulls/{pull_number}/reviews": 403 } },
    });
    const r = published(report);
    expect(r.degraded).toBe(true);
    expect(r.inline).toHaveLength(0);
    expect(r.warnings.join(" ")).toContain("Pull requests: write");
    expect(github.state.issueComments).toHaveLength(1);
    expect(github.state.issueComments[0]!.body).toContain("Problem 1");
    expect(github.state.issueComments[0]!.body).toContain("Pull requests: write");
  });

  it("422 on the review: posts the good comments one by one and lists the rejected one in the summary", async () => {
    const { report, github } = await run(
      [
        finding(1),
        finding(2, { filePath: "src/b.ts", title: "Bad position" }),
        finding(3, { filePath: "src/c.ts" }),
      ],
      { github: { invalidPaths: ["src/b.ts"] } },
    );
    const r = published(report);
    expect(github.state.reviews).toHaveLength(0);
    expect(github.state.singleComments.map((c) => c.path)).toEqual(["src/a.ts", "src/c.ts"]);
    expect(r.inline.map((p) => p.finding.id)).toEqual([fp(1), fp(3)]);
    expect(r.warnings.join(" ")).toContain("rejected 1 inline comment");
    expect(r.degraded).toBe(true);
    expect(github.state.issueComments[0]!.body).toContain("Bad position");
  });

  it("a 5xx on the review is a warning too", async () => {
    const { report } = await run([finding(1)], {
      github: { failures: { "POST /repos/{owner}/{repo}/pulls/{pull_number}/reviews": 503 } },
    });
    expect(published(report).warnings.join(" ")).toContain("GitHub was unavailable");
  });

  it("403 on the summary is a warning", async () => {
    const { report } = await run([finding(1)], {
      github: { failures: { "POST /repos/{owner}/{repo}/issues": 403 } },
    });
    const r = published(report);
    expect(r.summary).toBeUndefined();
    expect(r.degraded).toBe(true);
    expect(r.warnings.join(" ")).toContain("summary comment");
  });

  it("without a head it can confirm, posts no inline comments but still the summary", async () => {
    const { report, github } = await run([finding(1)], {
      github: { failures: { "GET /repos/{owner}/{repo}/pulls/{pull_number}": 500 } },
    });
    expect(github.state.reviews).toHaveLength(0);
    expect(github.state.issueComments).toHaveLength(1);
    expect(published(report).degraded).toBe(true);
  });
});

describe("the summary comment (FR-20, FR-21, FR-31, FR-32, AC-2)", () => {
  it("is created once with the hidden marker, then updated in place", async () => {
    const context = await buildContext(files());
    const github = createFakePublisherGitHub({ headSha: HEAD_SHA });
    const input = {
      client: github.client,
      repo: REPO,
      context,
      result: result([finding(1)]),
    };

    const first = published(await publishReview(input));
    expect(first.summary?.created).toBe(true);
    expect(github.state.issueComments).toHaveLength(1);
    expect(hasSummaryMarker(github.state.issueComments[0]!.body)).toBe(true);

    const second = published(
      await publishReview({
        ...input,
        context: { ...context, prior: { ...context.prior, summaryCommentId: first.summary!.id } },
        result: result([finding(1), finding(2, { filePath: "src/b.ts" })]),
      }),
    );
    expect(second.summary).toEqual({ id: first.summary!.id, created: false });
    expect(github.state.issueComments).toHaveLength(1);
    expect(github.state.issueComments[0]!.body).toContain("Problem 2");
  });

  it("never edits a comment that is not ours, even if it carries the marker", async () => {
    const human = {
      id: 7,
      body: `<!-- ai-pr-review:summary -->\nmine`,
      login: "octocat",
      type: "User",
    };
    const context = await buildContext(files());
    const github = createFakePublisherGitHub({ headSha: HEAD_SHA, issueComments: [human] });
    const report = published(
      await publishReview({
        client: github.client,
        repo: REPO,
        context: { ...context, prior: { ...context.prior, summaryCommentId: 7 } },
        result: result([finding(1)]),
        appLogin: "ai-review[bot]",
      }),
    );
    expect(report.summary?.created).toBe(true);
    expect(github.state.issueComments.find((c) => c.id === 7)!.body).toBe(human.body);
    expect(github.calls.some((c) => c.route.startsWith("PATCH /repos/{owner}/{repo}/issues"))).toBe(
      false,
    );
    expect(github.state.issueComments).toHaveLength(2);
  });

  it("creates a new summary when the old one was deleted", async () => {
    const context = await buildContext(files());
    const github = createFakePublisherGitHub({ headSha: HEAD_SHA });
    const report = published(
      await publishReview({
        client: github.client,
        repo: REPO,
        context: { ...context, prior: { ...context.prior, summaryCommentId: 4242 } },
        result: result([]),
      }),
    );
    expect(report.summary?.created).toBe(true);
  });

  it("shows status, counts by severity, the agent of each finding, skipped files and the run link", async () => {
    const context = await buildContext([...files(), file("package-lock.json")]);
    const { github } = await run(
      [
        finding(1, { severity: "critical", title: "Critical thing" }),
        finding(2, { severity: "medium", title: "Medium thing", filePath: "src/b.ts" }),
        finding(3, {
          severity: "info",
          confidence: 0.99,
          title: "Info thing",
          filePath: "src/c.ts",
        }),
      ],
      {
        context,
        result: { warnings: ["Code Review: the AI provider timed out."], status: "partial" },
      },
    );
    const body = github.state.issueComments[0]!.body;
    expect(body).toContain("**Status:** Partial");
    expect(body).toContain("3 findings: 1 critical, 1 medium, 1 info.");
    expect(body).toContain("| 1 | 0 | 1 | 0 | 1 |");
    expect(body).toContain("_Code Review_");
    expect(body).toContain("Files not reviewed (1)");
    expect(body).toContain("package-lock.json");
    expect(body).toContain("Code Review: the AI provider timed out.");
    expect(body).toContain("https://dash.example/runs/r1");
    expect(body).toContain("| Test Coverage | Not run |");
    expect(body).toContain("| Security | Not run |");
  });
});

describe("redaction on every outgoing body (FR-29)", () => {
  it("removes planted secrets, forged markers and images from model text in comments and summary", async () => {
    const planted = finding(1, {
      title: `Leaks ${FAKE.github}`,
      evidence: `const token = "${FAKE.aws}";`,
      impact: `Anyone can read ${FAKE.openai}. ![x](https://evil.example/?d=1) <!-- ai-pr-review:summary -->`,
      recommendation: `Rotate ${FAKE.slack} and ping @octocat`,
    });
    const { github } = await run([planted]);

    const bodies = [
      github.state.reviews[0]!.comments[0]!.body,
      github.state.issueComments[0]!.body,
    ];
    for (const body of bodies) {
      for (const secret of [FAKE.github, FAKE.aws, FAKE.openai, FAKE.slack]) {
        expect(body).not.toContain(secret);
      }
      expect(body).not.toContain("evil.example");
      expect(body).not.toMatch(/@octocat/);
    }
    // The only summary marker in the summary comment is ours, and the inline comment has none.
    expect(github.state.issueComments[0]!.body.match(/<!--\s*ai-pr-review:summary/g)).toHaveLength(
      1,
    );
    expect(hasSummaryMarker(github.state.reviews[0]!.comments[0]!.body)).toBe(false);
  });

  it("quotes at most a few short lines of evidence, never an excerpt of the code", async () => {
    const big = Array.from({ length: 50 }, (_, i) => `const line${i} = ${"x".repeat(200)};`).join(
      "\n",
    );
    const { github } = await run([finding(1, { evidence: big })]);
    const body = github.state.reviews[0]!.comments[0]!.body;
    expect(body.length).toBeLessThan(3_000);
    expect(body).not.toContain("line10");
  });
});

describe("a skipped or failed review is still explained", () => {
  it("posts a summary for a PR skipped by the size policy", async () => {
    const context = await buildContext(files());
    const { github } = await run([], {
      context,
      result: { status: "skipped", reason: "The pull request is too large to review reliably." },
    });
    const body = github.state.issueComments[0]!.body;
    expect(body).toContain("**Status:** Skipped");
    expect(body).toContain("Not reviewed: The pull request is too large to review reliably.");
    expect(github.state.reviews).toHaveLength(0);
  });

  it("posts a summary for a failed run", async () => {
    const { github } = await run([], {
      result: { status: "failed", reason: "Every review agent failed." },
    });
    expect(github.state.issueComments[0]!.body).toContain(
      "The review failed: Every review agent failed.",
    );
  });
});
