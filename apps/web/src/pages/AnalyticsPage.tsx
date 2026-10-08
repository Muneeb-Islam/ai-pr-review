import {
  ANALYTICS_TARGETS,
  judgeMetric,
  MIN_SAMPLE_SIZE,
  SEVERITIES,
  type AnalyticsMetric,
} from "@ai-pr-review/shared/api";
import type { ReactNode } from "react";
import { ChartFrame, HBars, LineChart, StackedBars } from "../components/charts/charts";
import { AlertIcon, CheckIcon, CrossIcon } from "../components/icons";
import { EmptyState, ErrorState, LoadingState } from "../components/States";
import {
  useAnalyticsSummary,
  useAnalyticsTimeseries,
  type AnalyticsSummary,
  type AnalyticsTimeseries,
} from "../hooks/insights";
import { useRepos } from "../hooks/queries";
import { formatDuration, formatNumber, formatPercent, formatUsd } from "../lib/format";
import { useDocumentTitle } from "../lib/useDocumentTitle";
import { useUrlParams } from "../lib/useUrlParams";

const RANGES = [7, 30, 90, 180] as const;
const DEFAULT_DAYS = 30;

const CAUSE_LABELS: Record<keyof AnalyticsTimeseries["points"][number]["causes"], string> = {
  timeout: "An agent timed out",
  invalid_output: "A model answered invalidly",
  agent_failed: "An agent or provider failed",
  other: "Another cause",
};

/** Stack order: orange, blue, red (the order the palette was validated in, so neighbours stay distinguishable). */
const OUTCOMES = [
  { name: "Partial", color: "var(--chart-2)" },
  { name: "Completed", color: "var(--chart-1)" },
  { name: "Failed", color: "var(--chart-3)" },
];

const compact = new Intl.NumberFormat("en", { notation: "compact", maximumFractionDigits: 1 });

// ---------- tiles ----------

function Verdict({
  metric,
  value,
  sample,
}: {
  metric: AnalyticsMetric;
  value: number | null;
  sample: number;
}) {
  const target = ANALYTICS_TARGETS[metric];
  const verdict = judgeMetric(metric, value, sample);
  const icon =
    verdict.state === "met" ? (
      <CheckIcon />
    ) : verdict.state === "missed" ? (
      <CrossIcon />
    ) : (
      <AlertIcon />
    );
  const text =
    verdict.state === "met" ? "Met" : verdict.state === "missed" ? "Not met" : "No data yet";
  return (
    <>
      <p className="mt-2 text-xs" data-testid={`target-${metric}`} data-state={verdict.state}>
        Target: {target.label} ·{" "}
        <span className="inline-flex items-center gap-1 font-semibold">
          {icon}
          {text}
        </span>
      </p>
      {verdict.small_sample && verdict.state !== "no_data" ? (
        <p className="text-muted mt-1 text-xs">
          Small sample (under {MIN_SAMPLE_SIZE}): read this with care.
        </p>
      ) : null}
    </>
  );
}

function Tile({
  title,
  value,
  detail,
  children,
  testId,
}: {
  title: string;
  value: string;
  detail?: ReactNode;
  children?: ReactNode;
  testId: string;
}) {
  return (
    <article className="card p-4" data-testid={testId} aria-label={title}>
      <h3 className="text-muted text-xs font-semibold">{title}</h3>
      <p className="mt-1 text-2xl font-semibold">{value}</p>
      {detail ? <p className="text-muted mt-1 text-xs">{detail}</p> : null}
      {children}
    </article>
  );
}

const rateText = (rate: number | null) => (rate === null ? "–" : formatPercent(rate));
const count = (n: number, noun: string) => `${formatNumber(n)} ${noun}${n === 1 ? "" : "s"}`;

function Tiles({ s }: { s: AnalyticsSummary }) {
  const r = s.reviews;
  const otherRuns = r.skipped + r.superseded + r.cancelled;
  return (
    <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
      <Tile
        testId="tile-reviews"
        title="Reviews"
        value={formatNumber(r.total)}
        detail={`${r.completed} completed · ${r.partial} partial · ${r.failed} failed · ${otherRuns} not reviewed · ${r.in_progress} in progress`}
      >
        <p className="text-muted mt-2 text-xs">
          Across {s.repositories} {s.repositories === 1 ? "repository" : "repositories"}.
        </p>
      </Tile>
      <Tile
        testId="tile-completion"
        title="Completion rate"
        value={rateText(s.completion.rate)}
        detail={`${count(s.completion.sample, "finished review")} (completed, partial or failed)`}
      >
        <Verdict metric="completion_rate" value={s.completion.rate} sample={s.completion.sample} />
      </Tile>
      <Tile
        testId="tile-duration"
        title="Median review duration"
        value={s.duration.median_ms === null ? "–" : formatDuration(s.duration.median_ms)}
        detail={`${count(s.duration.sample, "completed or partial review")}, start to finish`}
      >
        <Verdict
          metric="median_duration_ms"
          value={s.duration.median_ms}
          sample={s.duration.sample}
        />
      </Tile>
      <Tile
        testId="tile-actionable"
        title="Actionable rate"
        value={rateText(s.feedback.actionable_rate)}
        detail={`${s.feedback.useful} of ${count(s.feedback.votes, "vote")} on posted findings said useful (${count(s.feedback.rated_findings, "finding")} rated)`}
      >
        <Verdict
          metric="actionable_rate"
          value={s.feedback.actionable_rate}
          sample={s.feedback.votes}
        />
      </Tile>
      <Tile
        testId="tile-false-positive"
        title="False-positive rate"
        value={rateText(s.feedback.false_positive_rate)}
        detail={`${s.feedback.false_positive} of ${count(s.feedback.votes, "vote")} said false positive; ${s.feedback.known} said already known`}
      >
        <Verdict
          metric="false_positive_rate"
          value={s.feedback.false_positive_rate}
          sample={s.feedback.votes}
        />
      </Tile>
      <Tile
        testId="tile-duplicates"
        title="Duplicate-comment rate"
        value={rateText(s.duplicates.rate)}
        detail={`${s.duplicates.runs_with_duplicates} of ${count(s.duplicates.runs_with_comments, "review")} with inline comments posted one again for the same commit`}
      >
        <Verdict
          metric="duplicate_rate"
          value={s.duplicates.rate}
          sample={s.duplicates.runs_with_comments}
        />
      </Tile>
      <Tile
        testId="tile-summary"
        title="Summary coverage"
        value={rateText(s.summary_coverage.rate)}
        detail={`${s.summary_coverage.with_summary} of ${count(s.summary_coverage.eligible, "finished review")} ended with a summary comment`}
      >
        <Verdict
          metric="summary_coverage"
          value={s.summary_coverage.rate}
          sample={s.summary_coverage.eligible}
        />
      </Tile>
      <Tile
        testId="tile-findings"
        title="Findings reported"
        value={formatNumber(s.findings.total)}
        detail={`${s.findings.posted} as inline comments · ${s.findings.suppressed} dropped by the review`}
      />
      <Tile
        testId="tile-usage"
        title="Tokens and estimated cost"
        value={formatNumber(s.usage.input_tokens + s.usage.output_tokens)}
        detail={`${formatNumber(s.usage.input_tokens)} in · ${formatNumber(s.usage.output_tokens)} out`}
      >
        <p className="mt-2 text-xs" data-testid="cost">
          {s.usage.estimated_cost_usd === null
            ? "Cost: not estimated (no provider is set for these repositories)."
            : `Estimated cost: about ${formatUsd(s.usage.estimated_cost_usd)}${
                s.usage.unpriced_tokens > 0
                  ? `, not counting ${formatNumber(s.usage.unpriced_tokens)} tokens of repositories without a provider`
                  : ""
              }.`}
        </p>
        <p className="text-muted mt-1 text-xs">
          An estimate from rough list prices of each repository&apos;s current provider, not a bill.
        </p>
      </Tile>
    </div>
  );
}

// ---------- charts ----------

const bucketLabel = (iso: string) =>
  new Date(iso).toLocaleDateString("en", { month: "short", day: "numeric", timeZone: "UTC" });

function Charts({ s, t }: { s: AnalyticsSummary; t: AnalyticsTimeseries }) {
  const labels = t.points.map((p) => bucketLabel(p.start));
  const per = t.bucket === "week" ? "week (starting Monday, UTC)" : "day (UTC)";
  const causes = (Object.keys(CAUSE_LABELS) as Array<keyof typeof CAUSE_LABELS>).map((key) => ({
    label: CAUSE_LABELS[key],
    value: t.points.reduce((n, p) => n + p.causes[key], 0),
  }));
  const failures = causes.reduce((n, c) => n + c.value, 0);

  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <ChartFrame
        title="Reviews over time"
        note={`Reviews that ran to an end, per ${per}.`}
        legend={OUTCOMES}
        table={{
          caption: "Reviews per period by outcome",
          columns: ["Period", "Completed", "Partial", "Failed"],
          rows: t.points.map((p, i) => [labels[i]!, p.completed, p.partial, p.failed]),
        }}
      >
        <StackedBars
          ariaLabel="Reviews over time, stacked by outcome"
          labels={labels}
          series={OUTCOMES}
          values={t.points.map((p) => [p.partial, p.completed, p.failed])}
        />
      </ChartFrame>

      <ChartFrame
        title="Severity mix"
        note="Findings the reviews reported in this period."
        table={{
          caption: "Findings by severity",
          columns: ["Severity", "Findings"],
          rows: SEVERITIES.map((sev) => [sev, s.findings.by_severity[sev]]),
        }}
      >
        <HBars
          ariaLabel="Findings by severity"
          color="var(--chart-1)"
          rows={SEVERITIES.map((sev) => ({
            label: sev[0]!.toUpperCase() + sev.slice(1),
            value: s.findings.by_severity[sev],
          }))}
        />
      </ChartFrame>

      <ChartFrame
        title="Duration trend"
        note={`Median time from start to finish, per ${per}. The dashed line is the 5-minute target.`}
        table={{
          caption: "Median review duration per period",
          columns: ["Period", "Median duration"],
          rows: t.points.map((p, i) => [
            labels[i]!,
            p.median_duration_ms === null ? "no reviews" : formatDuration(p.median_duration_ms),
          ]),
        }}
      >
        <LineChart
          ariaLabel="Median review duration over time"
          labels={labels}
          values={t.points.map((p) => p.median_duration_ms)}
          color="var(--chart-1)"
          seriesName="Median duration"
          format={(n) => formatDuration(n)}
          reference={{ value: ANALYTICS_TARGETS.median_duration_ms.goal, label: "Target: 5 min" }}
        />
      </ChartFrame>

      <ChartFrame
        title="Failures and partial results by cause"
        note={
          failures === 0
            ? "No partial or failed reviews in this period."
            : "Partial and failed reviews in this period, by what went wrong."
        }
        table={{
          caption: "Partial and failed reviews by cause",
          columns: ["Cause", "Reviews"],
          rows: causes.map((c) => [c.label, c.value]),
        }}
      >
        <HBars
          ariaLabel="Partial and failed reviews by cause"
          color="var(--chart-2)"
          rows={causes}
        />
      </ChartFrame>

      <div className="lg:col-span-2">
        <ChartFrame
          title="Token usage"
          note={`Input and output tokens, per ${per}.`}
          legend={[
            { name: "Input tokens", color: "var(--chart-1)" },
            { name: "Output tokens", color: "var(--chart-2)" },
          ]}
          table={{
            caption: "Tokens per period",
            columns: ["Period", "Input tokens", "Output tokens"],
            rows: t.points.map((p, i) => [
              labels[i]!,
              formatNumber(p.input_tokens),
              formatNumber(p.output_tokens),
            ]),
          }}
        >
          <StackedBars
            ariaLabel="Token usage over time, stacked by input and output"
            labels={labels}
            series={[
              { name: "Input tokens", color: "var(--chart-1)" },
              { name: "Output tokens", color: "var(--chart-2)" },
            ]}
            values={t.points.map((p) => [p.input_tokens, p.output_tokens])}
            format={(n) => compact.format(n)}
            width={1280}
          />
        </ChartFrame>
      </div>
    </div>
  );
}

// ---------- the page ----------

/**
 * Analytics (UI-07): the PRD section 13 success metrics, each with its target, whether it is met and how many
 * observations it rests on, and charts of reviews, severity, duration, failures and usage.
 */
export function AnalyticsPage() {
  useDocumentTitle("Analytics");
  const { params, update } = useUrlParams();
  const repos = useRepos();
  const repoId = params.get("repo") ?? "";
  const asked = Number(params.get("days"));
  const days = (RANGES as readonly number[]).includes(asked) ? asked : DEFAULT_DAYS;

  const summary = useAnalyticsSummary(repoId, days);
  const series = useAnalyticsTimeseries(repoId, days);

  return (
    <div>
      <h1 className="text-xl font-semibold">Analytics</h1>
      <p className="text-muted mt-1 text-sm">
        How the reviews are doing against the targets. Quality rates come from the feedback people
        give on findings.
      </p>

      <form
        aria-label="Analytics range"
        className="card mt-4 flex flex-wrap items-end gap-3 p-3"
        onSubmit={(e) => e.preventDefault()}
      >
        <div>
          <label htmlFor="analytics-repo" className="label">
            Repository
          </label>
          <select
            id="analytics-repo"
            className="field w-56 max-w-full"
            value={repoId}
            onChange={(e) => update({ repo: e.target.value })}
          >
            <option value="">All repositories</option>
            {(repos.data ?? []).map((r) => (
              <option key={r.id} value={r.id}>
                {r.full_name}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label htmlFor="analytics-range" className="label">
            Period
          </label>
          <select
            id="analytics-range"
            className="field"
            value={days}
            onChange={(e) =>
              update({ days: e.target.value === String(DEFAULT_DAYS) ? "" : e.target.value })
            }
          >
            {RANGES.map((d) => (
              <option key={d} value={d}>
                Last {d} days
              </option>
            ))}
          </select>
        </div>
      </form>

      <div className="mt-4 space-y-4">
        {summary.isPending ? (
          <LoadingState label="Loading analytics…" />
        ) : summary.isError ? (
          <ErrorState error={summary.error} onRetry={() => void summary.refetch()} />
        ) : summary.data.reviews.total === 0 ? (
          <EmptyState title="No reviews in this period">
            Nothing was queued in the last {days} days{repoId ? " for this repository" : ""}. Pick a
            longer period, or open a pull request.
          </EmptyState>
        ) : (
          <>
            <Tiles s={summary.data} />
            {series.isPending ? (
              <LoadingState label="Loading charts…" />
            ) : series.isError ? (
              <ErrorState
                error={series.error}
                onRetry={() => void series.refetch()}
                title="The charts could not be loaded"
              />
            ) : (
              <Charts s={summary.data} t={series.data} />
            )}
          </>
        )}
      </div>
    </div>
  );
}
