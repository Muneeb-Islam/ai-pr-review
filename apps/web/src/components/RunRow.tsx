import { Link } from "react-router";
import type { RunSummary } from "../hooks/queries";
import { isActive, TRIGGER_LABELS } from "../lib/format";
import { RunDuration } from "./Duration";
import { RelativeTime } from "./RelativeTime";
import { SeverityCounts } from "./SeverityBadge";
import { StatusBadge } from "./StatusBadge";

/**
 * One run in a list. Queued and running runs carry an accent bar and a tinted background (and their badge says
 * so in words), so the ones in flight stand out without relying on colour.
 */
export function RunRow({ run }: { run: RunSummary }) {
  const active = isActive(run.status);
  return (
    <li
      data-run={run.id}
      data-active={active ? "true" : undefined}
      className={`card flex flex-wrap items-center gap-x-6 gap-y-2 p-4 ${
        active ? "border-l-accent bg-highlight border-l-4" : ""
      }`}
    >
      <div className="min-w-0 flex-1 basis-56">
        <Link to={`/runs/${run.id}`} className="font-semibold break-all">
          {run.repo_full_name} <span className="font-normal">#{run.pr_number}</span>
        </Link>
        <div className="text-muted mt-1 flex flex-wrap gap-x-3 text-xs">
          <span>
            Base: <code>{run.base_ref}</code>
          </span>
          <span>{TRIGGER_LABELS[run.trigger] ?? run.trigger}</span>
          {run.triggered_by ? <span>by {run.triggered_by}</span> : null}
        </div>
      </div>
      <div className="flex min-w-36 flex-col items-start gap-1">
        <StatusBadge status={run.status} />
        {run.status_reason && !active ? (
          <span className="text-muted line-clamp-2 text-xs" title={run.status_reason}>
            {run.status_reason}
          </span>
        ) : null}
      </div>
      <div className="min-w-32 text-sm">
        <SeverityCounts counts={run.finding_counts} />
      </div>
      <div className="text-muted min-w-28 text-sm">
        <div>
          <RunDuration run={run} />
        </div>
        <div className="text-xs">
          <RelativeTime iso={run.queued_at} />
        </div>
      </div>
    </li>
  );
}
