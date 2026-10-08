// The pilot report (Phase 16): the PRD §13 metrics as counts with percentages, each judged against its target the
// way the dashboard judges it, with the sample size beside every figure. Pure: `scripts/pilot-report.ts` reads the
// database and hands the numbers here, so the wording is tested without one.
import {
  ANALYTICS_TARGETS,
  judgeMetric,
  MIN_SAMPLE_SIZE,
  type AnalyticsMetric,
} from "@ai-pr-review/shared";

export interface SizeClassUsage {
  label: string;
  runs: number;
  medianInputTokens: number;
  medianOutputTokens: number;
  /** Estimated dollars for the median run, or null when no provider price applies. */
  estimatedCostUsd: number | null;
}

export interface PilotData {
  from: Date;
  to: Date;
  repositories: number;
  reviews: { total: number; completed: number; partial: number; failed: number; skipped: number };
  completion: { ok: number; finished: number };
  durationMedianMs: number | null;
  durationSample: number;
  feedback: { votes: number; useful: number; falsePositive: number; known: number };
  duplicates: { runsWithDuplicates: number; runsWithComments: number };
  summary: { withSummary: number; eligible: number };
  findings: { total: number; posted: number; suppressed: number };
  sizeClasses: SizeClassUsage[];
}

const pct = (n: number, d: number): string => (d === 0 ? "n/a" : `${((100 * n) / d).toFixed(1)}%`);
const ratio = (n: number, d: number): number | null => (d === 0 ? null : n / d);

export function formatDuration(ms: number | null): string {
  if (ms === null) return "n/a";
  const seconds = Math.round(ms / 1000);
  return seconds < 60 ? `${seconds} s` : `${Math.floor(seconds / 60)} min ${seconds % 60} s`;
}

const VERDICT = { met: "Met", missed: "Missed", no_data: "No data" } as const;

interface Row {
  metric: string;
  key: AnalyticsMetric;
  value: number | null;
  measured: string;
  sample: number;
}

export function metricRows(d: PilotData): Row[] {
  return [
    {
      metric: "Workflow completion rate",
      key: "completion_rate",
      value: ratio(d.completion.ok, d.completion.finished),
      measured: `${pct(d.completion.ok, d.completion.finished)} (${d.completion.ok} of ${d.completion.finished} runs)`,
      sample: d.completion.finished,
    },
    {
      metric: "Median review duration",
      key: "median_duration_ms",
      value: d.durationMedianMs,
      measured: `${formatDuration(d.durationMedianMs)} (median of ${d.durationSample} runs)`,
      sample: d.durationSample,
    },
    {
      metric: "Actionable finding rate",
      key: "actionable_rate",
      value: ratio(d.feedback.useful, d.feedback.votes),
      measured: `${pct(d.feedback.useful, d.feedback.votes)} (${d.feedback.useful} of ${d.feedback.votes} votes)`,
      sample: d.feedback.votes,
    },
    {
      metric: "False-positive rate",
      key: "false_positive_rate",
      value: ratio(d.feedback.falsePositive, d.feedback.votes),
      measured: `${pct(d.feedback.falsePositive, d.feedback.votes)} (${d.feedback.falsePositive} of ${d.feedback.votes} votes)`,
      sample: d.feedback.votes,
    },
    {
      metric: "Duplicate-comment rate",
      key: "duplicate_rate",
      value: ratio(d.duplicates.runsWithDuplicates, d.duplicates.runsWithComments),
      measured: `${pct(d.duplicates.runsWithDuplicates, d.duplicates.runsWithComments)} (${d.duplicates.runsWithDuplicates} of ${d.duplicates.runsWithComments} runs with inline comments)`,
      sample: d.duplicates.runsWithComments,
    },
    {
      metric: "Summary coverage",
      key: "summary_coverage",
      value: ratio(d.summary.withSummary, d.summary.eligible),
      measured: `${pct(d.summary.withSummary, d.summary.eligible)} (${d.summary.withSummary} of ${d.summary.eligible} runs)`,
      sample: d.summary.eligible,
    },
  ];
}

export function renderPilotReport(d: PilotData): string {
  const day = (date: Date) => date.toISOString().slice(0, 10);
  const lines: string[] = [
    `# Pilot report, ${day(d.from)} to ${day(d.to)}`,
    "",
    `${d.repositories} ${d.repositories === 1 ? "repository" : "repositories"}, ${d.reviews.total} runs: ${d.reviews.completed} completed, ${d.reviews.partial} partial, ${d.reviews.failed} failed, ${d.reviews.skipped} skipped. ${d.findings.total} findings, ${d.findings.posted} posted inline, ${d.findings.suppressed} suppressed before posting.`,
    "",
    "| Metric | Target | Measured | Verdict |",
    "|---|---|---|---|",
  ];
  const thin: string[] = [];
  for (const row of metricRows(d)) {
    const verdict = judgeMetric(row.key, row.value, row.sample);
    let text: string = VERDICT[verdict.state];
    if (verdict.state !== "no_data" && verdict.small_sample) text += " (small sample)";
    if (verdict.small_sample) thin.push(row.metric);
    lines.push(
      `| ${row.metric} | ${ANALYTICS_TARGETS[row.key].label} | ${row.measured} | ${text} |`,
    );
  }
  lines.push("");
  if (thin.length > 0) {
    lines.push(
      `**Extend the pilot:** fewer than ${MIN_SAMPLE_SIZE} observations (or none) behind ${thin.join(", ")}. A rate on that few runs or votes says very little; keep collecting before calling a target met or missed.`,
      "",
    );
  }
  lines.push(
    'The false-positive rate counts only findings someone rated. A low rate reached by suppressing too much hides missed issues, so compare it with the manual spot check (docs/pilot.md, "Spot check").',
    "",
    "## Token use by size of the review",
    "",
  );
  if (d.sizeClasses.every((c) => c.runs === 0)) {
    lines.push("No finished runs in the period.", "");
  } else {
    lines.push(
      "Size is the number of input tokens a run sent (a run's file count is not stored). Cost is an estimate from the price table in `apps/api/src/analytics/pricing.ts` for the provider named when the report was run.",
      "",
      "| Input tokens sent | Runs | Median input | Median output | Estimated cost of the median run |",
      "|---|---|---|---|---|",
    );
    for (const c of d.sizeClasses) {
      if (c.runs === 0) {
        lines.push(`| ${c.label} | 0 | n/a | n/a | n/a |`);
        continue;
      }
      const cost = c.estimatedCostUsd === null ? "n/a" : `$${c.estimatedCostUsd.toFixed(4)}`;
      lines.push(
        `| ${c.label} | ${c.runs} | ${c.medianInputTokens} | ${c.medianOutputTokens} | ${cost} |`,
      );
    }
    lines.push("");
  }
  return lines.join("\n");
}
