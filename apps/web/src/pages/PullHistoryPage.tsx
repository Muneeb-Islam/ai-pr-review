import { ApiError } from "@ai-pr-review/shared/api";
import { Link, useParams } from "react-router";
import { RunDuration } from "../components/Duration";
import { ExternalLink } from "../components/ExternalLink";
import { RelativeTime } from "../components/RelativeTime";
import { SeverityBadge } from "../components/SeverityBadge";
import { EmptyState, ErrorState, LoadingState } from "../components/States";
import { StatusBadge } from "../components/StatusBadge";
import { usePullHistory, type PullHistory } from "../hooks/insights";
import { shortSha, TRIGGER_LABELS } from "../lib/format";
import { useDocumentTitle } from "../lib/useDocumentTitle";

type Entry = PullHistory["runs"][number];
type Change = NonNullable<Entry["changes"]>;
type Ref = Change["new"][number];

const GROUPS: Array<{
  key: keyof Pick<Change, "new" | "still_applicable" | "resolved" | "not_evaluated">;
  label: string;
  hint?: string;
}> = [
  { key: "new", label: "New" },
  { key: "still_applicable", label: "Still applicable" },
  {
    key: "resolved",
    label: "Resolved",
    hint: "Reported before; this review looked again and found nothing.",
  },
  {
    key: "not_evaluated",
    label: "Not evaluated",
    hint: "Reported before; this review could not tell (its check did not finish or the file was left out).",
  },
];

function RefList({ items }: { items: Ref[] }) {
  return (
    <ul className="mt-1 space-y-1">
      {items.map((f) => (
        <li key={f.id} className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm">
          <SeverityBadge severity={f.severity} />
          <Link to={`/findings/${f.id}`}>{f.title}</Link>
          {f.file_path ? (
            <code className="text-muted text-xs break-all">
              {f.file_path}
              {f.start_line !== null ? `:${f.start_line}` : ""}
            </code>
          ) : null}
        </li>
      ))}
    </ul>
  );
}

function Changes({ changes }: { changes: Change }) {
  const counts = GROUPS.map((g) => [g, changes[g.key]] as const).filter(
    ([, list]) => list.length > 0,
  );
  if (counts.length === 0) {
    return (
      <p className="text-muted text-sm">
        {changes.compared_to ? "No findings, and none before." : "The review reported nothing."}
      </p>
    );
  }
  return (
    <div className="space-y-3">
      <p className="text-sm" data-testid="change-summary">
        {counts.map(([g, list]) => `${list.length} ${g.label.toLowerCase()}`).join(" · ")}
        {changes.compared_to ? "" : " (first review)"}
      </p>
      {counts.map(([g, list]) => (
        <div key={g.key}>
          <h4 className="text-xs font-semibold">
            {g.label} ({list.length})
          </h4>
          {g.hint ? <p className="text-muted text-xs">{g.hint}</p> : null}
          <RefList items={list} />
        </div>
      ))}
    </div>
  );
}

/**
 * Every run of one pull request, oldest first, with what changed in the findings between reviews (UI-05, FR-37):
 * new, still applicable and resolved, so a reader can see whether a push fixed what the last review raised.
 */
export function PullHistoryPage() {
  const { repoId = "", number = "" } = useParams();
  const prNumber = Number(number);
  const valid = Number.isInteger(prNumber) && prNumber > 0;
  const query = usePullHistory(repoId, prNumber);
  const data = query.data;
  useDocumentTitle(
    data ? `${data.repo_full_name} #${data.pr_number} history` : "Pull request history",
  );

  const back = (
    <Link to="/runs" className="text-sm">
      ← All runs
    </Link>
  );
  if (!valid) {
    return (
      <div className="space-y-4">
        {back}
        <EmptyState title="Page not found">That is not a pull request number.</EmptyState>
      </div>
    );
  }
  if (query.isPending) return <LoadingState label="Loading history…" />;
  if (query.isError) {
    const notFound = query.error instanceof ApiError && query.error.status === 404;
    return (
      <div className="space-y-4">
        {back}
        {notFound ? (
          <EmptyState title="No runs for this pull request">
            It may not have been reviewed, may be older than the retention window, or you may not
            have access to its repository.
          </EmptyState>
        ) : (
          <ErrorState error={query.error} onRetry={() => void query.refetch()} />
        )}
      </div>
    );
  }
  if (!data) return null;

  return (
    <div className="space-y-5">
      {back}
      <header className="space-y-1">
        <h1 className="text-xl font-semibold break-all">
          {data.repo_full_name} <span className="font-normal">#{data.pr_number}</span> history
        </h1>
        <p className="text-sm">
          <ExternalLink href={data.pr_url}>Open the pull request on GitHub</ExternalLink>
        </p>
        {data.truncated ? (
          <p className="text-muted text-sm">Only the latest {data.runs.length} runs are shown.</p>
        ) : null}
      </header>

      <ol aria-label="Runs of this pull request, oldest first" className="space-y-4">
        {data.runs.map(({ run, changes }) => (
          <li key={run.id} data-run={run.id} className="card p-4 sm:p-5">
            <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
              <StatusBadge status={run.status} />
              <Link to={`/runs/${run.id}`} className="font-semibold">
                Commit <code>{shortSha(run.head_sha)}</code>
              </Link>
              <span className="text-muted text-sm">
                {TRIGGER_LABELS[run.trigger] ?? run.trigger} · <RunDuration run={run} /> ·{" "}
                <RelativeTime iso={run.queued_at} />
              </span>
            </div>
            {run.status_reason && run.status !== "completed" ? (
              <p className="text-muted mt-1 text-xs">{run.status_reason}</p>
            ) : null}
            <div className="mt-3">
              {changes ? (
                <Changes changes={changes} />
              ) : (
                <p className="text-muted text-sm">
                  This run did not produce a review, so it says nothing about findings.
                </p>
              )}
            </div>
          </li>
        ))}
      </ol>
    </div>
  );
}
