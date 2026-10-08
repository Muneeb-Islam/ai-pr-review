import { ApiError } from "@ai-pr-review/shared/api";
import { Link, useParams } from "react-router";
import { ExternalLink } from "../components/ExternalLink";
import { FeedbackControl } from "../components/FeedbackControl";
import { RelativeTime } from "../components/RelativeTime";
import { SeverityBadge } from "../components/SeverityBadge";
import { EmptyState, ErrorState, LoadingState } from "../components/States";
import { ShieldIcon } from "../components/icons";
import { useFinding } from "../hooks/insights";
import {
  AGENT_LABELS,
  CATEGORY_LABELS,
  formatPlace,
  shortSha,
  SUPPRESS_LABELS,
} from "../lib/format";
import { useDocumentTitle } from "../lib/useDocumentTitle";

/** One finding in full (UI-05): evidence, impact, recommendation, suggested test, the way back to GitHub, feedback. */
export function FindingDetailPage() {
  const { id = "" } = useParams();
  const query = useFinding(id);
  const f = query.data;
  useDocumentTitle(f ? f.title : "Finding");

  const back = (
    <Link to="/findings" className="text-sm">
      ← All findings
    </Link>
  );
  if (query.isPending) return <LoadingState label="Loading finding…" />;
  if (query.isError) {
    const notFound = query.error instanceof ApiError && query.error.status === 404;
    return (
      <div className="space-y-4">
        {back}
        {notFound ? (
          <EmptyState title="Finding not found">
            It may not exist, may have been removed by the retention cleanup, or you may not have
            access to its repository.
          </EmptyState>
        ) : (
          <ErrorState error={query.error} onRetry={() => void query.refetch()} />
        )}
      </div>
    );
  }
  if (!f) return null;

  const place = formatPlace(f);
  const suppressed = f.suppressed_reason !== null;
  return (
    <div className="space-y-5">
      {back}
      <header className="space-y-2">
        <div className="flex flex-wrap items-center gap-3">
          <SeverityBadge severity={f.severity} />
          {f.category === "security" ? (
            <span className="inline-flex items-center gap-1 text-sm font-semibold">
              <ShieldIcon />
              Security
            </span>
          ) : null}
          <h1 className="text-xl font-semibold">{f.title}</h1>
        </div>
        <p className="text-muted text-sm">
          {place ? <code className="break-all">{place}</code> : "General finding"} ·{" "}
          <Link className="underline" to={`/runs/${f.run_id}`}>
            {f.repo_full_name} #{f.pr_number}
          </Link>{" "}
          · commit <code title={f.head_sha}>{shortSha(f.head_sha)}</code> ·{" "}
          <RelativeTime iso={f.queued_at} />
        </p>
        <p className="flex flex-wrap gap-x-4 gap-y-1 text-sm">
          {f.github_url ? (
            <ExternalLink href={f.github_url}>
              {f.posted ? "Open the comment on GitHub" : "Open the code on GitHub"}
            </ExternalLink>
          ) : (
            <span className="text-muted">This finding has no place in the code to link to.</span>
          )}
          <Link to={`/repos/${f.repo_id}/pulls/${f.pr_number}`}>History of this pull request</Link>
        </p>
      </header>

      <section aria-labelledby="detail-title" className="card space-y-3 p-4 sm:p-5">
        <h2 id="detail-title" className="text-base font-semibold">
          What was found
        </h2>
        <dl className="space-y-3 text-sm">
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
        <p className="text-muted flex flex-wrap gap-x-4 text-xs">
          <span>{CATEGORY_LABELS[f.category] ?? f.category}</span>
          <span>{AGENT_LABELS[f.agent] ?? f.agent}</span>
          <span>Confidence {Math.round(f.confidence * 100)}%</span>
          <span>
            {suppressed
              ? `Not reported: ${SUPPRESS_LABELS[f.suppressed_reason!] ?? f.suppressed_reason}`
              : f.posted
                ? "Inline comment posted"
                : "In the summary only"}
          </span>
        </p>
      </section>

      <section aria-labelledby="feedback-title" className="card space-y-2 p-4 sm:p-5">
        <h2 id="feedback-title" className="text-base font-semibold">
          Your feedback
        </h2>
        {suppressed ? (
          <p className="text-muted text-sm">
            This finding was left out of the review, so there is nothing to rate.
          </p>
        ) : (
          <>
            <p className="text-muted text-sm">
              Was it worth raising? Your answer is kept with your name and counts once; you can
              change it later. The totals feed the dashboard&apos;s quality numbers.
            </p>
            <FeedbackControl findingId={f.id} feedback={f.feedback} />
          </>
        )}
      </section>
    </div>
  );
}
