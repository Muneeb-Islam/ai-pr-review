// Findings as the API shows them: the finding, its feedback, and where to find it on GitHub. The same builder
// serves the run detail, the findings explorer and a single finding, so the three never disagree.
import {
  findInlineCommentIds,
  summarizeFeedback,
  type FeedbackSummary,
  type FindingWithRun,
  type InstallationIds,
  type Database,
  type StoredFinding,
} from "@ai-pr-review/db";
import type { ExplorerFindingDto } from "@ai-pr-review/shared";

const iso = (date: Date) => date.toISOString();

const encodePath = (path: string) => path.split("/").map(encodeURIComponent).join("/");

/**
 * Where a finding lives on GitHub: the inline comment when one was posted, else the file and lines at the
 * reviewed commit, else nothing (a general finding has no place).
 */
export function findingUrl(input: {
  repoFullName: string;
  prNumber: number;
  headSha: string;
  finding: Pick<StoredFinding, "filePath" | "startLine" | "endLine">;
  commentId: number | undefined;
}): string | null {
  const base = `https://github.com/${input.repoFullName}`;
  if (input.commentId !== undefined)
    return `${base}/pull/${input.prNumber}#discussion_r${input.commentId}`;
  const { filePath, startLine, endLine } = input.finding;
  if (!filePath) return null;
  const file = `${base}/blob/${encodeURIComponent(input.headSha)}/${encodePath(filePath)}`;
  if (startLine === null) return file;
  return endLine !== null && endLine !== startLine
    ? `${file}#L${startLine}-L${endLine}`
    : `${file}#L${startLine}`;
}

export const toFeedbackDto = (summary: FeedbackSummary) => ({
  useful: summary.useful,
  false_positive: summary.false_positive,
  known: summary.known,
  mine: summary.mine,
});

/** The fields of a finding every view shows. */
export function toFindingDto(
  f: StoredFinding,
  extras: { feedback: FeedbackSummary; url: string | null },
) {
  return {
    id: f.id,
    agent: f.agent,
    category: f.category,
    severity: f.severity,
    confidence: f.confidence,
    title: f.title,
    file_path: f.filePath,
    start_line: f.startLine,
    end_line: f.endLine,
    evidence: f.evidence,
    impact: f.impact,
    recommendation: f.recommendation,
    suggested_test: f.suggestedTest,
    posted: f.posted,
    suppressed_reason: f.suppressedReason,
    github_url: extras.url,
    feedback: toFeedbackDto(extras.feedback),
  };
}

/**
 * Findings with their feedback totals (and the caller's own vote) and GitHub links, in the order given. Two
 * queries for the whole list, however long it is.
 */
export async function toFindingDtos(
  db: Database,
  installationIds: InstallationIds,
  userId: string,
  rows: readonly FindingWithRun[],
  repoName: (repoId: string) => string,
) {
  const [feedback, comments] = await Promise.all([
    summarizeFeedback(
      db,
      installationIds,
      rows.map((r) => r.finding.id),
      userId,
    ),
    findInlineCommentIds(
      db,
      installationIds,
      rows
        .filter((r) => r.finding.posted)
        .map((r) => ({ runId: r.run.id, fingerprint: r.finding.fingerprint })),
    ),
  ]);
  return rows.map(({ finding, run }) =>
    toFindingDto(finding, {
      feedback: feedback.get(finding.id)!,
      url: findingUrl({
        repoFullName: repoName(run.repoId),
        prNumber: run.prNumber,
        headSha: run.headSha,
        finding,
        commentId: comments.get(`${run.id}:${finding.fingerprint}`),
      }),
    }),
  );
}

/** The same, with the run and pull request each finding belongs to (the explorer and a single finding). */
export async function toExplorerFindings(
  db: Database,
  installationIds: InstallationIds,
  userId: string,
  rows: readonly FindingWithRun[],
  repoName: (repoId: string) => string,
): Promise<ExplorerFindingDto[]> {
  const base = await toFindingDtos(db, installationIds, userId, rows, repoName);
  return rows.map(({ run }, i) => {
    const repoFullName = repoName(run.repoId);
    return {
      ...base[i]!,
      run_id: run.id,
      repo_id: run.repoId,
      repo_full_name: repoFullName,
      pr_number: run.prNumber,
      pr_url: `https://github.com/${repoFullName}/pull/${run.prNumber}`,
      head_sha: run.headSha,
      queued_at: iso(run.queuedAt),
    };
  });
}
