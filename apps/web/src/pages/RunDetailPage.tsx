import { ApiError } from "@ai-pr-review/shared/api";
import type { ReactNode } from "react";
import { Link, useParams, useSearchParams } from "react-router";
import { RunDuration } from "../components/Duration";
import { ExternalLink } from "../components/ExternalLink";
import { FeedbackControl } from "../components/FeedbackControl";
import { AlertIcon, ShieldIcon } from "../components/icons";
import { RunActions } from "../components/RunActions";
import { RelativeTime } from "../components/RelativeTime";
import { SeverityBadge } from "../components/SeverityBadge";
import { EmptyState, ErrorState, LoadingState } from "../components/States";
import { StatusBadge } from "../components/StatusBadge";
import { useRepos, useRun, type RunDetail } from "../hooks/queries";
import {
  AGENT_LABELS,
  AGENT_STATUS_LABELS,
  CATEGORY_LABELS,
  formatDuration,
  formatExact,
  formatNumber,
  isActive,
  shortSha,
  STATUS_LABELS,
  SUPPRESS_LABELS,
  TRIGGER_LABELS,
} from "../lib/format";
import { SECURITY_ADVISORY, securityOverview } from "../lib/security";
import { useSecondNow } from "../lib/ticker";
import { useDocumentTitle } from "../lib/useDocumentTitle";

const ms = (iso: string) => new Date(iso).getTime();

function Section({ id, title, children }: { id: string; title: string; children: ReactNode }) {
  return (
    <section aria-labelledby={id} className="card p-4 sm:p-5">
      <h2 id={id} className="mb-3 text-base font-semibold">
        {title}
      </h2>
      {children}
    </section>
  );
}

// ---------- timeline ----------

interface Step {
  key: string;
  label: string;
  at?: string;
  detail?: ReactNode;
  done: boolean;
}

function Timeline({ run }: { run: RunDetail }) {
  const now = useSecondNow();
  const steps: Step[] = [
    {
      key: "queued",
      label: "Queued",
      at: run.queued_at,
      detail: TRIGGER_LABELS[run.trigger] ?? run.trigger,
      done: true,
    },
  ];
  if (run.started_at) {
    steps.push({
      key: "started",
      label: "Started",
      at: run.started_at,
      detail: `Waited ${formatDuration(ms(run.started_at) - ms(run.queued_at))} for a worker`,
      done: true,
    });
  } else if (!run.finished_at) {
    steps.push({ key: "started", label: "Started", detail: "Waiting for a worker", done: false });
  }
  if (run.finished_at) {
    const took = run.started_at
      ? `Took ${formatDuration(ms(run.finished_at) - ms(run.started_at))}`
      : undefined;
    steps.push({
      key: "finished",
      label: STATUS_LABELS[run.status],
      at: run.finished_at,
      detail: [took, run.status_reason].filter(Boolean).join(" · ") || undefined,
      done: true,
    });
  } else {
    steps.push({
      key: "finished",
      label: "Finished",
      detail:
        run.status === "running" && run.started_at
          ? `Running for ${formatDuration(now - ms(run.started_at))}`
          : "Not finished yet",
      done: false,
    });
  }

  return (
    <ol aria-label="Run timeline" className="space-y-4">
      {steps.map((step, index) => (
        <li
          key={step.key}
          className="flex gap-3"
          aria-current={!step.done && index > 0 && steps[index - 1]?.done ? "step" : undefined}
        >
          <span
            aria-hidden="true"
            className={`mt-1 h-3 w-3 shrink-0 rounded-full border-2 ${
              step.done ? "bg-accent border-accent" : "border-muted bg-transparent"
            }`}
          />
          <div className="min-w-0">
            <div className="text-sm font-semibold">
              {step.label}
              {step.at ? (
                <span className="text-muted ml-2 font-normal">
                  <RelativeTime iso={step.at} />
                  <span className="sr-only"> ({formatExact(step.at)})</span>
                </span>
              ) : null}
            </div>
            {step.detail ? <div className="text-muted text-sm">{step.detail}</div> : null}
          </div>
        </li>
      ))}
    </ol>
  );
}

// ---------- agent runs ----------

function AgentRuns({ run }: { run: RunDetail }) {
  if (run.agent_runs.length === 0) {
    return (
      <p className="text-muted text-sm">
        {isActive(run.status)
          ? "Agents have not reported yet."
          : "No agent ran for this run (it ended before the review started)."}
      </p>
    );
  }
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-left text-sm">
        <caption className="sr-only">Agents that ran in this run</caption>
        <thead className="text-muted text-xs">
          <tr>
            <th scope="col" className="py-1 pr-4 font-semibold">
              Agent
            </th>
            <th scope="col" className="py-1 pr-4 font-semibold">
              Status
            </th>
            <th scope="col" className="py-1 pr-4 font-semibold">
              Duration
            </th>
            <th scope="col" className="py-1 pr-4 font-semibold">
              Tokens (in / out)
            </th>
            <th scope="col" className="py-1 pr-4 font-semibold">
              Retries
            </th>
          </tr>
        </thead>
        <tbody>
          {run.agent_runs.map((agent) => (
            <tr key={agent.agent} className="border-border border-t align-top">
              <th scope="row" className="py-2 pr-4 font-medium">
                {AGENT_LABELS[agent.agent] ?? agent.agent}
                {agent.warnings.length > 0 ? (
                  <ul className="text-muted mt-1 list-disc pl-4 text-xs font-normal">
                    {agent.warnings.map((warning, i) => (
                      <li key={i}>{warning}</li>
                    ))}
                  </ul>
                ) : null}
              </th>
              <td className="py-2 pr-4">{AGENT_STATUS_LABELS[agent.status] ?? agent.status}</td>
              <td className="py-2 pr-4">{formatDuration(agent.duration_ms)}</td>
              <td className="py-2 pr-4">
                {formatNumber(agent.input_tokens)} / {formatNumber(agent.output_tokens)}
              </td>
              <td className="py-2 pr-4">{agent.retries}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// ---------- coverage ----------

type Coverage = NonNullable<RunDetail["coverage"]>;
type CoverageFile = Coverage["files"][number];

const percent = (share: number) => `${Math.round(share * 100)}%`;

function ranges(file: CoverageFile): string {
  return file.uncovered
    .map((r) => (r.start === r.end ? `${r.start}` : `${r.start}–${r.end}`))
    .join(", ");
}

function CoverageFileRow({ file }: { file: CoverageFile }) {
  if (file.status === "not_in_report") {
    return (
      <tr className="border-border border-t align-top">
        <th scope="row" className="py-2 pr-4 font-normal">
          <code className="break-all">{file.path}</code>
        </th>
        <td className="text-muted py-2 pr-4" colSpan={3}>
          Not in the report, so its coverage is unknown
        </td>
      </tr>
    );
  }
  const none = file.total_lines === 0;
  return (
    <tr className="border-border border-t align-top">
      <th scope="row" className="py-2 pr-4 font-normal">
        <code className="break-all">{file.path}</code>
      </th>
      <td className="py-2 pr-4 whitespace-nowrap">
        {none ? (
          <span className="text-muted">No executable changed lines</span>
        ) : (
          <>
            {percent(file.covered_lines / file.total_lines)}{" "}
            <span className="text-muted">
              ({file.covered_lines} of {file.total_lines})
            </span>
          </>
        )}
      </td>
      <td className="py-2 pr-4">{file.uncovered.length > 0 ? ranges(file) : "–"}</td>
      <td className="py-2 pr-4">
        {file.uncovered_functions.length > 0 ? (
          <span className="break-all">{file.uncovered_functions.join(", ")}</span>
        ) : (
          "–"
        )}
      </td>
    </tr>
  );
}

/**
 * What CI's coverage report says about the changed lines (FR-22), or why there is none (FR-23). Measured numbers
 * live here and in the summary's coverage block; suggestions from reading the diff are findings, labelled as such.
 */
function CoverageDetails({ run, coverage }: { run: RunDetail; coverage: Coverage }) {
  if (coverage.status !== "measured") {
    return (
      <div className="space-y-1 text-sm">
        <p className="font-medium">
          {coverage.status === "skipped"
            ? "Coverage was not measured."
            : "Coverage could not be measured."}
        </p>
        {coverage.reason ? <p className="text-muted">{coverage.reason}</p> : null}
        {coverage.status === "not_available" ? (
          <p className="text-muted">
            Test suggestions come from reading the diff, not from a coverage report.
          </p>
        ) : null}
      </div>
    );
  }
  const deficient = coverage.files.filter(
    (f) => f.status === "measured" && f.total_lines > 0 && f.covered_lines < f.total_lines,
  ).length;
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        {coverage.changed_line_coverage !== null ? (
          <>
            <span className="text-2xl font-semibold" data-testid="coverage-percent">
              {percent(coverage.changed_line_coverage)}
            </span>
            <span className="text-sm">
              of changed lines covered ({coverage.covered_lines} of {coverage.total_lines}{" "}
              executable lines)
            </span>
          </>
        ) : (
          <span className="text-sm">The report has no executable changed lines to count.</span>
        )}
      </div>
      <p className="text-muted text-sm">
        Measured from the coverage report CI uploaded
        {coverage.artifact_name ? <> (artifact “{coverage.artifact_name}”</> : null}
        {coverage.artifact_run_id !== null ? (
          <>
            {", "}
            <ExternalLink
              href={`https://github.com/${run.repo_full_name}/actions/runs/${coverage.artifact_run_id}`}
            >
              workflow run
            </ExternalLink>
          </>
        ) : null}
        {coverage.artifact_name ? ")" : null}.
        {deficient > 0
          ? ` ${deficient} ${deficient === 1 ? "file has" : "files have"} changed lines that never ran.`
          : ""}
      </p>
      {coverage.files.length > 0 ? (
        <div className="overflow-x-auto">
          <table className="w-full text-left text-sm">
            <caption className="sr-only">Coverage of the changed lines, by file</caption>
            <thead className="text-muted text-xs">
              <tr>
                <th scope="col" className="py-1 pr-4 font-semibold">
                  File
                </th>
                <th scope="col" className="py-1 pr-4 font-semibold">
                  Changed lines covered
                </th>
                <th scope="col" className="py-1 pr-4 font-semibold">
                  Lines not run
                </th>
                <th scope="col" className="py-1 pr-4 font-semibold">
                  Functions not called
                </th>
              </tr>
            </thead>
            <tbody>
              {coverage.files.map((file) => (
                <CoverageFileRow key={file.path} file={file} />
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
    </div>
  );
}

// ---------- findings ----------

function location(f: RunDetail["findings"][number]): string | undefined {
  if (!f.file_path) return undefined;
  if (f.start_line === null) return f.file_path;
  return f.end_line !== null && f.end_line !== f.start_line
    ? `${f.file_path}:${f.start_line}–${f.end_line}`
    : `${f.file_path}:${f.start_line}`;
}

/** The security status of the run (FR-28): what the Security agent concluded, and the findings that need a look. */
function SecurityDetails({ run }: { run: RunDetail }) {
  const overview = securityOverview(run);
  if (!overview) return null;
  return (
    <section
      aria-labelledby="security-title"
      data-testid="security-panel"
      data-level={overview.level}
      className={`card p-4 sm:p-5 ${overview.level === "attention" ? "border-sev-high-fg border-2" : ""}`}
    >
      <h2 id="security-title" className="mb-3 flex items-center gap-2 text-base font-semibold">
        <ShieldIcon className="h-4 w-4" />
        Security
      </h2>
      <p className={`text-sm ${overview.level === "attention" ? "font-semibold" : ""}`}>
        {overview.text}
      </p>
      {overview.callouts.length > 0 ? (
        <ul aria-label="Security findings that need attention" className="mt-3 space-y-2">
          {overview.callouts.map((f) => (
            <li key={f.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm">
              <SeverityBadge severity={f.severity} />
              <span className="font-medium">{f.title}</span>
              {location(f) ? (
                <code className="text-muted text-xs break-all">{location(f)}</code>
              ) : null}
            </li>
          ))}
        </ul>
      ) : null}
      <p className="text-muted mt-3 text-xs">{SECURITY_ADVISORY}</p>
    </section>
  );
}

function Findings({ run }: { run: RunDetail }) {
  const [params, setParams] = useSearchParams();
  if (run.findings.length === 0) {
    return (
      <p className="text-muted text-sm">
        {isActive(run.status)
          ? "No findings yet."
          : run.status === "completed" || run.status === "partial"
            ? "The review found nothing to report."
            : "This run produced no findings."}
      </p>
    );
  }

  // Categories in the order they appear most often first; the filter only offers what the run has.
  const counts = new Map<string, number>();
  for (const f of run.findings) counts.set(f.category, (counts.get(f.category) ?? 0) + 1);
  const categories = [...counts.entries()].sort((a, b) => b[1] - a[1]).map(([name]) => name);
  const wanted = params.get("category");
  const category = wanted && counts.has(wanted) ? wanted : null;
  const shown = category ? run.findings.filter((f) => f.category === category) : run.findings;
  const choose = (next: string | null) => {
    const copy = new URLSearchParams(params);
    if (next) copy.set("category", next);
    else copy.delete("category");
    setParams(copy, { replace: true });
  };
  const chip = (active: boolean) =>
    `rounded border px-2 py-1 text-xs font-medium ${
      active
        ? "bg-accent text-accent-fg border-accent"
        : "border-border bg-surface hover:bg-surface-2"
    }`;

  return (
    <>
      {categories.length > 1 ? (
        <div
          role="group"
          aria-label="Filter findings by category"
          className="mb-3 flex flex-wrap gap-2"
        >
          <button
            type="button"
            aria-pressed={category === null}
            className={chip(category === null)}
            onClick={() => choose(null)}
          >
            All ({run.findings.length})
          </button>
          {categories.map((name) => (
            <button
              key={name}
              type="button"
              aria-pressed={category === name}
              className={chip(category === name)}
              onClick={() => choose(name)}
            >
              {CATEGORY_LABELS[name] ?? name} ({counts.get(name)})
            </button>
          ))}
        </div>
      ) : null}
      <FindingList findings={shown} />
    </>
  );
}

function FindingList({ findings }: { findings: RunDetail["findings"] }) {
  return (
    <ul className="space-y-3">
      {findings.map((f) => (
        <li
          key={f.id}
          data-category={f.category}
          className={`border-border rounded border p-3 ${
            f.category === "security" ? "border-l-sev-high-fg border-l-4" : ""
          }`}
        >
          <details>
            <summary className="flex cursor-pointer flex-wrap items-center gap-x-3 gap-y-1">
              <SeverityBadge severity={f.severity} />
              {f.category === "security" ? (
                <span className="inline-flex items-center gap-1 text-xs font-semibold">
                  <ShieldIcon />
                  Security
                </span>
              ) : null}
              <span className="font-medium">{f.title}</span>
              {location(f) ? (
                <code className="text-muted text-xs break-all">{location(f)}</code>
              ) : (
                <span className="text-muted text-xs">General</span>
              )}
            </summary>
            <dl className="mt-3 space-y-2 text-sm">
              <div>
                <dt className="text-muted text-xs font-semibold">Evidence</dt>
                <dd>
                  <pre className="bg-surface-2 overflow-x-auto rounded p-2 text-xs break-words whitespace-pre-wrap">
                    {f.evidence}
                  </pre>
                </dd>
              </div>
              <div>
                <dt className="text-muted text-xs font-semibold">Impact</dt>
                <dd>{f.impact}</dd>
              </div>
              <div>
                <dt className="text-muted text-xs font-semibold">
                  {f.category === "security" ? "Mitigation" : "Recommendation"}
                </dt>
                <dd>{f.recommendation}</dd>
              </div>
              {f.suggested_test ? (
                <div>
                  <dt className="text-muted text-xs font-semibold">Suggested test</dt>
                  <dd>{f.suggested_test}</dd>
                </div>
              ) : null}
            </dl>
            <div className="text-muted mt-3 flex flex-wrap gap-x-4 text-xs">
              <span>
                {f.category === "test_gap"
                  ? "Suggested missing test (from reading the diff, not measured)"
                  : (CATEGORY_LABELS[f.category] ?? f.category)}
              </span>
              <span>{AGENT_LABELS[f.agent] ?? f.agent}</span>
              <span>Confidence {Math.round(f.confidence * 100)}%</span>
              <span>{f.posted ? "Inline comment posted" : "Summary only"}</span>
            </div>
            <div className="mt-3 flex flex-wrap items-start justify-between gap-3">
              <FeedbackControl findingId={f.id} feedback={f.feedback} compact />
              <div className="flex flex-wrap gap-x-4 gap-y-1 text-sm">
                <Link to={`/findings/${f.id}`}>Details</Link>
                {f.github_url ? (
                  <ExternalLink href={f.github_url}>
                    {f.posted ? "Comment on GitHub" : "Code on GitHub"}
                  </ExternalLink>
                ) : null}
              </div>
            </div>
          </details>
        </li>
      ))}
    </ul>
  );
}

// ---------- what became of the previous review (FR-37) ----------

type Tracking = NonNullable<RunDetail["tracking"]>;

const TRACKED_LABELS: Record<Tracking["items"][number]["state"], string> = {
  resolved: "Resolved",
  still_applicable: "Still applicable",
  not_evaluated: "Not evaluated",
};

/** The previous review's findings and whether this run found them again, fixed them or could not tell. */
function TrackingDetails({ tracking }: { tracking: Tracking }) {
  const counts = new Map<string, number>();
  for (const item of tracking.items) counts.set(item.state, (counts.get(item.state) ?? 0) + 1);
  return (
    <div className="space-y-3">
      <p className="text-sm">
        Compared with the review of commit <code>{shortSha(tracking.previous_head_sha)}</code> (
        <Link className="underline" to={`/runs/${tracking.previous_run_id}`}>
          that run
        </Link>
        ):{" "}
        {(Object.keys(TRACKED_LABELS) as Array<keyof typeof TRACKED_LABELS>)
          .filter((state) => counts.has(state))
          .map((state) => `${counts.get(state)} ${TRACKED_LABELS[state].toLowerCase()}`)
          .join(" · ")}
        .
      </p>
      <ul className="space-y-2" aria-label="Findings of the previous review">
        {tracking.items.map((item, i) => (
          <li
            key={i}
            data-state={item.state}
            className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm"
          >
            <span className="w-28 shrink-0 text-xs font-semibold">
              {TRACKED_LABELS[item.state]}
            </span>
            <SeverityBadge severity={item.severity} />
            <span className="font-medium">{item.title}</span>
            {item.file_path ? (
              <code className="text-muted text-xs break-all">
                {item.file_path}
                {item.start_line !== null ? `:${item.start_line}` : ""}
              </code>
            ) : null}
            {item.reason ? <span className="text-muted text-xs">{item.reason}</span> : null}
          </li>
        ))}
      </ul>
    </div>
  );
}

// ---------- the page ----------

export function RunDetailPage() {
  const { id = "" } = useParams();
  const query = useRun(id);
  const run = query.data;
  const repos = useRepos();
  const isAdmin = repos.data?.find((r) => r.id === run?.repo_id)?.role === "admin";
  useDocumentTitle(run ? `${run.repo_full_name} #${run.pr_number}` : "Run");

  const back = (
    <Link to="/runs" className="text-sm">
      ← All runs
    </Link>
  );

  if (query.isPending) return <LoadingState label="Loading run…" />;
  if (query.isError) {
    const notFound = query.error instanceof ApiError && query.error.status === 404;
    return (
      <div className="space-y-4">
        {back}
        {notFound ? (
          <EmptyState title="Run not found">
            It may not exist, or you may not have access to its repository.
          </EmptyState>
        ) : (
          <ErrorState error={query.error} onRetry={() => void query.refetch()} />
        )}
      </div>
    );
  }
  if (!run) return null;

  const suppressed = Object.entries(run.suppressed_counts).filter(([, n]) => n > 0);
  const totalTokens = run.usage.input_tokens + run.usage.output_tokens;

  return (
    <div className="space-y-5">
      {back}
      <header className="space-y-2">
        <div className="flex flex-wrap items-center gap-3">
          <h1 className="text-xl font-semibold break-all">
            {run.repo_full_name} <span className="font-normal">#{run.pr_number}</span>
          </h1>
          <StatusBadge status={run.status} />
        </div>
        <p className="text-muted text-sm">
          <RunDuration run={run} /> · queued <RelativeTime iso={run.queued_at} /> ·{" "}
          <Link className="underline" to={`/repos/${run.repo_id}/pulls/${run.pr_number}`}>
            History of this pull request
          </Link>
        </p>
        <RunActions run={run} isAdmin={isAdmin} />
      </header>

      {run.warnings.length > 0 ? (
        <section aria-labelledby="warnings-title" className="card border-st-partial-fg p-4">
          <h2 id="warnings-title" className="mb-2 flex items-center gap-2 text-base font-semibold">
            <AlertIcon className="h-4 w-4" />
            Warnings
          </h2>
          <ul className="list-disc space-y-1 pl-5 text-sm">
            {run.warnings.map((warning, i) => (
              <li key={i}>{warning}</li>
            ))}
          </ul>
        </section>
      ) : null}

      <div className="grid gap-5 lg:grid-cols-2">
        <Section id="details-title" title="Details">
          <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 text-sm">
            <dt className="text-muted">Pull request</dt>
            <dd>
              <ExternalLink href={run.pr_url}>
                {run.repo_full_name}#{run.pr_number}
              </ExternalLink>
            </dd>
            <dt className="text-muted">Check Run</dt>
            <dd>
              {run.check_run_url ? (
                <ExternalLink href={run.check_run_url}>View on GitHub</ExternalLink>
              ) : (
                <span className="text-muted">None yet</span>
              )}
            </dd>
            <dt className="text-muted">Trigger</dt>
            <dd>
              {TRIGGER_LABELS[run.trigger] ?? run.trigger}
              {run.triggered_by ? ` by ${run.triggered_by}` : ""}
            </dd>
            <dt className="text-muted">Base branch</dt>
            <dd>
              <code>{run.base_ref}</code>
            </dd>
            <dt className="text-muted">Base commit</dt>
            <dd>
              <code title={run.base_sha}>{shortSha(run.base_sha)}</code>
            </dd>
            <dt className="text-muted">Head commit</dt>
            <dd>
              <code title={run.head_sha}>{shortSha(run.head_sha)}</code>
            </dd>
            {run.parent_run_id ? (
              <>
                <dt className="text-muted">Re-run of</dt>
                <dd>
                  <Link to={`/runs/${run.parent_run_id}`}>Earlier run</Link>
                </dd>
              </>
            ) : null}
          </dl>
        </Section>

        <Section id="timeline-title" title="Timeline">
          <Timeline run={run} />
        </Section>
      </div>

      <Section id="agents-title" title="Agents">
        <AgentRuns run={run} />
      </Section>

      {run.coverage ? (
        <Section id="coverage-title" title="Coverage">
          <CoverageDetails run={run} coverage={run.coverage} />
        </Section>
      ) : null}

      <SecurityDetails run={run} />

      {run.tracking ? (
        <Section id="tracking-title" title="Since the previous review">
          <TrackingDetails tracking={run.tracking} />
        </Section>
      ) : null}

      <Section id="findings-title" title={`Findings (${run.findings.length})`}>
        <Findings run={run} />
        {suppressed.length > 0 ? (
          <p className="text-muted mt-3 text-sm">
            Not shown:{" "}
            {suppressed
              .map(([reason, n]) => `${n} ${SUPPRESS_LABELS[reason] ?? reason}`)
              .join(", ")}
            .
          </p>
        ) : null}
        {run.final_review ? (
          <p className="text-muted mt-3 text-sm" data-testid="final-review">
            Final review: {run.final_review.approved} approved, {run.final_review.rejected} rejected
            {run.final_review.unreviewed > 0 ? `, ${run.final_review.unreviewed} not checked` : ""}.
          </p>
        ) : null}
      </Section>

      <div className="grid gap-5 lg:grid-cols-2">
        <Section id="skipped-title" title={`Skipped files (${run.skipped_files.length})`}>
          {run.skipped_files.length === 0 ? (
            <p className="text-muted text-sm">Every changed file was reviewed.</p>
          ) : (
            <details open={run.skipped_files.length <= 8}>
              <summary className="cursor-pointer text-sm">Show the list</summary>
              <ul className="mt-2 space-y-1 text-sm">
                {run.skipped_files.map((file) => (
                  <li key={file.path} className="flex flex-wrap gap-x-3">
                    <code className="break-all">{file.path}</code>
                    <span className="text-muted">{file.reason}</span>
                  </li>
                ))}
              </ul>
            </details>
          )}
        </Section>

        <Section id="usage-title" title="Usage">
          <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 text-sm">
            <dt className="text-muted">Input tokens</dt>
            <dd>{formatNumber(run.usage.input_tokens)}</dd>
            <dt className="text-muted">Output tokens</dt>
            <dd>{formatNumber(run.usage.output_tokens)}</dd>
            <dt className="text-muted">Total</dt>
            <dd>{formatNumber(totalTokens)}</dd>
          </dl>
        </Section>
      </div>
    </div>
  );
}
