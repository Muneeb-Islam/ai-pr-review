import type { Finding } from "@ai-pr-review/shared";
import { describe, expect, it } from "vitest";
import { makeFinding } from "../agents/test-support";
import { renderCheckOutput, checkConclusion } from "./check";
import { renderSummary, type SummaryInput } from "./summary";

const SHA = "1234567890abcdef1234567890abcdef12345678";

const finding = (n: number, over: Partial<Finding> = {}): Finding =>
  makeFinding({
    id: n.toString(16).padStart(16, "0"),
    title: `Finding ${n}`,
    filePath: "src/a.ts",
    startLine: n,
    endLine: n,
    ...over,
  });

const base: SummaryInput = {
  status: "completed",
  headSha: SHA,
  findings: [],
  suppressedCounts: {},
  observations: [],
  agents: [
    { agent: "code_review", state: "ok" },
    { agent: "test_coverage", state: "not_available" },
    { agent: "security", state: "off" },
  ],
  skippedFiles: [],
  warnings: [],
  isDraft: false,
  inlineCapped: 0,
  dashboardUrl: "https://dash.example/runs/abc",
};

describe("summary snapshots", () => {
  it("no findings", () => {
    expect(renderSummary(base)).toMatchSnapshot();
  });

  it("mixed severities, test suggestion, notes and suppressed counts", () => {
    expect(
      renderSummary({
        ...base,
        findings: [
          {
            finding: finding(1, { severity: "critical", title: "SQL built from user input" }),
            inline: true,
          },
          { finding: finding(2, { severity: "high" }), inline: true },
          {
            finding: finding(3, {
              severity: "medium",
              filePath: undefined,
              startLine: undefined,
              endLine: undefined,
            }),
            inline: false,
          },
          { finding: finding(4, { severity: "low", confidence: 0.6 }), inline: false },
          {
            finding: finding(5, {
              category: "test_gap",
              agent: "test_coverage",
              severity: "medium",
              title: "No test for empty input",
              suggestedTest: "Call add() with an empty array and expect 0.",
            }),
            inline: false,
          },
        ],
        observations: [{ agent: "code_review", text: "The new helper is used in two places." }],
        suppressedCounts: { below_threshold: 2, duplicate: 1 },
      }),
    ).toMatchSnapshot();
  });

  it("partial run with warnings, skipped files and a limited review", () => {
    expect(
      renderSummary({
        ...base,
        status: "partial",
        limitReason: "Only 40 of 52 files were reviewed.",
        findings: [{ finding: finding(1), inline: true }],
        agents: [
          { agent: "code_review", state: "timeout" },
          { agent: "test_coverage", state: "not_available" },
          { agent: "security", state: "not_available" },
        ],
        skippedFiles: [
          { path: "package-lock.json", reason: "lockfile" },
          { path: "dist/app.js", reason: "build output" },
        ],
        warnings: ["Code Review: the AI provider timed out."],
        isDraft: true,
      }),
    ).toMatchSnapshot();
  });

  it("skipped", () => {
    expect(
      renderSummary({
        ...base,
        status: "skipped",
        reason: "The pull request is too large to review reliably.",
        agents: base.agents.map((a) => ({ ...a, state: "off" as const })),
      }),
    ).toMatchSnapshot();
  });
});

describe("summary size", () => {
  it("folds long lists and always fits in one GitHub comment", () => {
    const findings = Array.from({ length: 400 }, (_, i) => ({
      finding: finding(i + 1, {
        severity: "medium",
        impact: "x".repeat(400),
        recommendation: "y".repeat(400),
      }),
      inline: false,
    }));
    const body = renderSummary({ ...base, findings });
    expect(body.length).toBeLessThanOrEqual(60_000);
    expect(body).toContain("<details>");
    expect(body).toContain("<!-- ai-pr-review:summary -->");
  });
});

describe("Check Run conclusion and output (FR-30)", () => {
  it("success only for a completed, fully published review; neutral otherwise (design §14)", () => {
    expect(checkConclusion({ status: "completed", degraded: false })).toBe("success");
    expect(checkConclusion({ status: "completed", degraded: true })).toBe("neutral");
    for (const status of ["partial", "skipped", "failed", "superseded", "cancelled"] as const) {
      expect(checkConclusion({ status, degraded: false })).toBe("neutral");
    }
  });

  it("titles and summarises the outcome", () => {
    const out = renderCheckOutput({
      status: "completed",
      findings: [finding(1, { severity: "high" }), finding(2, { severity: "medium" })],
      warnings: [],
      degraded: false,
      headSha: SHA,
      dashboardUrl: "https://dash.example/runs/abc",
    });
    expect(out.title).toBe("2 findings: 1 high, 1 medium");
    expect(out.summary).toContain("Finding 1");
    expect(out.summary).toContain("https://dash.example/runs/abc");

    expect(
      renderCheckOutput({
        status: "completed",
        findings: [],
        warnings: [],
        degraded: false,
        headSha: SHA,
      }).title,
    ).toBe("No issues found");
    const skipped = renderCheckOutput({
      status: "skipped",
      reason: "Reviews are disabled for acme/widgets.",
      findings: [],
      warnings: [],
      degraded: false,
      headSha: SHA,
    });
    expect(skipped.title).toBe("Review skipped");
    expect(skipped.summary).toContain("Reviews are disabled for acme/widgets.");
  });
});
