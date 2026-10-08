import { Link } from "react-router";
import type { ExplorerFinding } from "../hooks/insights";
import { AGENT_LABELS, CATEGORY_LABELS, formatPlace, SUPPRESS_LABELS } from "../lib/format";
import { ExternalLink } from "./ExternalLink";
import { FeedbackControl } from "./FeedbackControl";
import { RelativeTime } from "./RelativeTime";
import { SeverityBadge } from "./SeverityBadge";
import { ShieldIcon } from "./icons";

/** One finding in the explorer: what it is and where, the pull request it came from, and feedback on it. */
export function FindingCard({ finding: f }: { finding: ExplorerFinding }) {
  const place = formatPlace(f);
  const suppressed = f.suppressed_reason !== null;
  return (
    <li
      data-finding={f.id}
      data-category={f.category}
      className={`card p-4 ${f.category === "security" ? "border-l-sev-high-fg border-l-4" : ""}`}
    >
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <SeverityBadge severity={f.severity} />
        {f.category === "security" ? (
          <span className="inline-flex items-center gap-1 text-xs font-semibold">
            <ShieldIcon />
            Security
          </span>
        ) : null}
        <Link to={`/findings/${f.id}`} className="font-semibold">
          {f.title}
        </Link>
      </div>
      <div className="text-muted mt-1 flex flex-wrap gap-x-4 gap-y-1 text-xs">
        {place ? <code className="break-all">{place}</code> : <span>General</span>}
        <span>
          <Link className="underline" to={`/runs/${f.run_id}`}>
            {f.repo_full_name} #{f.pr_number}
          </Link>
        </span>
        <span>{AGENT_LABELS[f.agent] ?? f.agent}</span>
        <span>{CATEGORY_LABELS[f.category] ?? f.category}</span>
        <span>Confidence {Math.round(f.confidence * 100)}%</span>
        <span>
          <RelativeTime iso={f.queued_at} />
        </span>
        <span>
          {suppressed
            ? `Not reported: ${SUPPRESS_LABELS[f.suppressed_reason!] ?? f.suppressed_reason}`
            : f.posted
              ? "Inline comment posted"
              : "Summary only"}
        </span>
      </div>
      <div className="mt-3 flex flex-wrap items-start justify-between gap-3">
        {suppressed ? (
          <p className="text-muted text-xs">
            This finding was left out of the review, so it cannot be rated.
          </p>
        ) : (
          <FeedbackControl findingId={f.id} feedback={f.feedback} compact />
        )}
        <div className="flex flex-wrap gap-x-4 gap-y-1 text-sm">
          <Link to={`/findings/${f.id}`}>Details</Link>
          {f.github_url ? (
            <ExternalLink href={f.github_url}>
              {f.posted ? "Comment on GitHub" : "Code on GitHub"}
            </ExternalLink>
          ) : null}
        </div>
      </div>
    </li>
  );
}
