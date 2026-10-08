import type { CoverageSummary } from "@ai-pr-review/shared";
import { describe, expect, it } from "vitest";
import { renderCheckOutput } from "./check";
import { renderSummary, type SummaryInput } from "./summary";

const SHA = "c".repeat(40);

const base: SummaryInput = {
  status: "completed",
  headSha: SHA,
  findings: [],
  suppressedCounts: {},
  observations: [],
  agents: [
    { agent: "code_review", state: "ok" },
    { agent: "test_coverage", state: "ok" },
    { agent: "security", state: "off" },
  ],
  skippedFiles: [],
  warnings: [],
  isDraft: false,
  inlineCapped: 0,
};

const measured: CoverageSummary = {
  status: "measured",
  changedLineCoverage: 0.75,
  coveredLines: 30,
  totalLines: 40,
  artifact: { name: "coverage", runId: 99 },
  observations: [],
  files: [
    {
      path: "src/orders.ts",
      status: "measured",
      coveredLines: 10,
      totalLines: 20,
      uncovered: [
        { start: 12, end: 14 },
        { start: 30, end: 30 },
      ],
      uncoveredFunctions: ["refund"],
    },
    { path: "src/ok.ts", status: "measured", coveredLines: 20, totalLines: 20, uncovered: [] },
    { path: "src/types.ts", status: "measured", coveredLines: 0, totalLines: 0, uncovered: [] },
    { path: "src/new.ts", status: "not_in_report", coveredLines: 0, totalLines: 0, uncovered: [] },
  ],
};

const section = (body: string): string => {
  const start = body.indexOf("### Coverage");
  const end = body.indexOf("###", start + 5);
  return body.slice(start, end === -1 ? undefined : end);
};

describe("the summary's coverage block (FR-22, FR-23, FR-25)", () => {
  it("shows measured coverage and labels the files that fall short as verified deficiencies", () => {
    const text = section(renderSummary({ ...base, coverage: measured }));
    expect(text).toContain(
      "**Measured: 75% of changed lines covered** (30 of 40 executable lines)",
    );
    expect(text).toContain(
      "- **Verified coverage deficiency** `src/orders.ts`: 50% (10 of 20); lines not run: 12-14, 30; never called: `refund`",
    );
    // Files that are fully covered, have no executable lines, or are unknown are not deficiencies.
    expect(text).not.toContain("`src/ok.ts`");
    expect(text).not.toContain("`src/types.ts`");
    expect(text).toContain(
      "Not in the report, so their coverage is unknown (not zero): `src/new.ts`.",
    );
  });

  it("says so when every executable changed line ran", () => {
    const text = section(
      renderSummary({
        ...base,
        coverage: {
          ...measured,
          changedLineCoverage: 1,
          coveredLines: 20,
          totalLines: 20,
          files: [measured.files![1]!],
        },
      }),
    );
    expect(text).toContain("**Measured: 100% of changed lines covered**");
    expect(text).toContain("Every executable changed line in the report ran.");
    expect(text).not.toContain("Verified coverage deficiency");
  });

  it("has no percentage when the report holds no executable changed line", () => {
    const text = section(
      renderSummary({
        ...base,
        coverage: { status: "measured", observations: [], files: [measured.files![2]!] },
      }),
    );
    expect(text).toContain("the report has no executable changed lines to count");
    expect(text).not.toMatch(/\d+%/);
  });

  it("states plainly that coverage could not be measured, and why, without a number (FR-23)", () => {
    const text = section(
      renderSummary({
        ...base,
        coverage: {
          status: "not_available",
          reasonCode: "no_artifact",
          reason: 'No CI run for this commit uploaded an artifact named "coverage".',
          observations: [],
        },
      }),
    );
    expect(text).toContain("**Coverage could not be measured.**");
    expect(text).toContain('No CI run for this commit uploaded an artifact named "coverage".');
    expect(text).toContain(
      "Test suggestions below come from reading the diff, not from a coverage report.",
    );
    expect(text).not.toMatch(/\d+%/);
  });

  it("says when coverage was not measured because nothing needed it", () => {
    const text = section(
      renderSummary({
        ...base,
        coverage: {
          status: "skipped",
          reasonCode: "no_source_files",
          reason: "The pull request changes no source file that coverage applies to.",
          observations: [],
        },
      }),
    );
    expect(text).toContain("Not measured. The pull request changes no source file");
  });

  it("leaves the block out when the agent did not run", () => {
    expect(renderSummary(base)).not.toContain("### Coverage");
  });

  it("cannot be made to forge a marker or a link through a file name or a reason", () => {
    const body = renderSummary({
      ...base,
      coverage: {
        ...measured,
        files: [
          {
            path: "src/<!-- ai-pr-review:summary -->`x`.ts",
            status: "measured",
            coveredLines: 0,
            totalLines: 3,
            uncovered: [{ start: 1, end: 3 }],
          },
        ],
        reason: undefined as never,
      },
    });
    expect(body.match(/<!-- ai-pr-review:summary -->/g)).toHaveLength(1); // only ours, at the top
  });

  it("lists at most a dozen deficient files and points to the dashboard for the rest", () => {
    const files = Array.from({ length: 20 }, (_, i) => ({
      path: `src/f${i}.ts`,
      status: "measured" as const,
      coveredLines: 1,
      totalLines: 2,
      uncovered: [{ start: 2, end: 2 }],
    }));
    const text = section(renderSummary({ ...base, coverage: { ...measured, files } }));
    expect(text.match(/Verified coverage deficiency/g)).toHaveLength(12);
    expect(text).toContain("…and 8 more files");
  });
});

describe("the Check Run's coverage line", () => {
  const outcome = {
    status: "completed" as const,
    findings: [],
    warnings: [],
    degraded: false,
    headSha: SHA,
  };

  it("gives the measured share", () => {
    expect(renderCheckOutput({ ...outcome, coverage: measured }).summary).toContain(
      "**Coverage:** 75% of changed lines (measured from the CI report).",
    );
  });

  it("says coverage was not measured and why", () => {
    const summary = renderCheckOutput({
      ...outcome,
      coverage: {
        status: "not_available",
        reason: "CI was still running when the review started, so no coverage report was ready.",
        observations: [],
      },
    }).summary;
    expect(summary).toContain("**Coverage:** not measured. CI was still running");
  });

  it("is silent when coverage was skipped or the agent did not run", () => {
    expect(renderCheckOutput({ ...outcome }).summary).not.toContain("Coverage");
    expect(
      renderCheckOutput({
        ...outcome,
        coverage: { status: "skipped", observations: [] },
      }).summary,
    ).not.toContain("Coverage");
  });
});
