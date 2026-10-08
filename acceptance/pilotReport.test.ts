// The pilot report states counts beside percentages, judges them like the dashboard does, and asks for a longer
// pilot instead of a verdict when the sample is small (phase 16, "Metrics").
import { describe, expect, it } from "vitest";
import { formatDuration, renderPilotReport, type PilotData } from "../scripts/lib/pilotReport";

const data = (over: Partial<PilotData> = {}): PilotData => ({
  from: new Date("2026-10-01T00:00:00Z"),
  to: new Date("2026-10-29T00:00:00Z"),
  repositories: 2,
  reviews: { total: 30, completed: 24, partial: 2, failed: 1, skipped: 3 },
  completion: { ok: 26, finished: 27 },
  durationMedianMs: 3 * 60_000 + 12_000,
  durationSample: 26,
  feedback: { votes: 40, useful: 30, falsePositive: 6, known: 4 },
  duplicates: { runsWithDuplicates: 0, runsWithComments: 20 },
  summary: { withSummary: 27, eligible: 27 },
  findings: { total: 60, posted: 35, suppressed: 25 },
  sizeClasses: [
    {
      label: "under 10,000",
      runs: 10,
      medianInputTokens: 6000,
      medianOutputTokens: 800,
      estimatedCostUsd: 0.0022,
    },
    {
      label: "10,000 to 50,000",
      runs: 14,
      medianInputTokens: 24000,
      medianOutputTokens: 1500,
      estimatedCostUsd: 0.008,
    },
    {
      label: "over 50,000",
      runs: 0,
      medianInputTokens: 0,
      medianOutputTokens: 0,
      estimatedCostUsd: null,
    },
  ],
  ...over,
});

describe("renderPilotReport", () => {
  it("shows every metric with its counts, percentage, target and verdict", () => {
    const report = renderPilotReport(data());
    expect(report).toContain(
      "| Workflow completion rate | At least 95% | 96.3% (26 of 27 runs) | Met |",
    );
    expect(report).toContain(
      "| Median review duration | Under 5 minutes | 3 min 12 s (median of 26 runs) | Met |",
    );
    expect(report).toContain(
      "| Actionable finding rate | At least 70% | 75.0% (30 of 40 votes) | Met |",
    );
    expect(report).toContain("| False-positive rate | Under 20% | 15.0% (6 of 40 votes) | Met |");
    expect(report).toContain(
      "| Duplicate-comment rate | Under 2% | 0.0% (0 of 20 runs with inline comments) | Met |",
    );
    expect(report).toContain("| Summary coverage | At least 90% | 100.0% (27 of 27 runs) | Met |");
    expect(report).not.toContain("Extend the pilot");
  });

  it("reports a missed target as missed", () => {
    const report = renderPilotReport(
      data({ feedback: { votes: 40, useful: 20, falsePositive: 14, known: 6 } }),
    );
    expect(report).toContain(
      "| Actionable finding rate | At least 70% | 50.0% (20 of 40 votes) | Missed |",
    );
    expect(report).toContain(
      "| False-positive rate | Under 20% | 35.0% (14 of 40 votes) | Missed |",
    );
  });

  it("asks for a longer pilot when a sample is small, and says so beside the verdict", () => {
    const report = renderPilotReport(
      data({ feedback: { votes: 4, useful: 4, falsePositive: 0, known: 0 } }),
    );
    expect(report).toContain("100.0% (4 of 4 votes) | Met (small sample) |");
    expect(report).toContain("**Extend the pilot:**");
    expect(report).toContain("Actionable finding rate, False-positive rate");
  });

  it("says there is no data instead of inventing a rate", () => {
    const report = renderPilotReport(
      data({
        reviews: { total: 0, completed: 0, partial: 0, failed: 0, skipped: 0 },
        completion: { ok: 0, finished: 0 },
        durationMedianMs: null,
        durationSample: 0,
        feedback: { votes: 0, useful: 0, falsePositive: 0, known: 0 },
        duplicates: { runsWithDuplicates: 0, runsWithComments: 0 },
        summary: { withSummary: 0, eligible: 0 },
        sizeClasses: [],
      }),
    );
    expect(report).toContain(
      "| Workflow completion rate | At least 95% | n/a (0 of 0 runs) | No data |",
    );
    expect(report).toContain("No finished runs in the period.");
  });

  it("lists token use by size class with an estimated cost", () => {
    const report = renderPilotReport(data());
    expect(report).toContain("| under 10,000 | 10 | 6000 | 800 | $0.0022 |");
    expect(report).toContain("| over 50,000 | 0 | n/a | n/a | n/a |");
  });

  it("formats durations", () => {
    expect(formatDuration(45_000)).toBe("45 s");
    expect(formatDuration(192_000)).toBe("3 min 12 s");
    expect(formatDuration(null)).toBe("n/a");
  });
});
