// What changed in a pull request's findings from one review to the next (FR-37, UI-05). The comparison is the one
// the worker makes when it writes the summary (`matchFindings`: the fingerprint first, then file, category, title
// and line), applied to the stored findings of consecutive reviews, so the history and the summary agree about
// which finding is "the same".
import { matchFindings, type PreviousFinding } from "@ai-pr-review/core";
import type { PullHistoryRun, StoredFinding } from "@ai-pr-review/db";
import {
  SEVERITIES,
  type Finding,
  type FindingRefDto,
  type HistoryChangesDto,
} from "@ai-pr-review/shared";

const REVIEWED = new Set(["completed", "partial"]);

/** Runs that produced a review: only those say anything about which findings exist. */
export const isReviewed = (status: string): boolean => REVIEWED.has(status);

const ref = (f: StoredFinding): FindingRefDto => ({
  id: f.id,
  agent: f.agent,
  category: f.category,
  severity: f.severity,
  title: f.title,
  file_path: f.filePath,
  start_line: f.startLine,
});

const asFinding = (f: StoredFinding, headSha: string): Finding => ({
  id: f.fingerprint,
  agent: f.agent,
  category: f.category,
  severity: f.severity,
  confidence: f.confidence,
  title: f.title,
  ...(f.filePath !== null ? { filePath: f.filePath } : {}),
  ...(f.startLine !== null ? { startLine: f.startLine } : {}),
  ...(f.endLine !== null ? { endLine: f.endLine } : {}),
  evidence: f.evidence,
  impact: f.impact,
  recommendation: f.recommendation,
  ...(f.suggestedTest !== null ? { suggestedTest: f.suggestedTest } : {}),
  sourceCommitSha: headSha,
});

const asPrevious = (f: StoredFinding): PreviousFinding => ({
  fingerprint: f.fingerprint,
  agent: f.agent,
  category: f.category,
  severity: f.severity,
  title: f.title,
  ...(f.filePath !== null ? { filePath: f.filePath } : {}),
  ...(f.startLine !== null ? { startLine: f.startLine } : {}),
  posted: f.posted,
});

const severityRank = new Map(SEVERITIES.map((s, i) => [s, i]));
const byPlace = (a: FindingRefDto, b: FindingRefDto) =>
  severityRank.get(a.severity)! - severityRank.get(b.severity)! ||
  (a.file_path ?? "").localeCompare(b.file_path ?? "") ||
  (a.start_line ?? 0) - (b.start_line ?? 0) ||
  a.id.localeCompare(b.id);

/**
 * For each run, oldest first: what its findings are compared with the last earlier run that reviewed (completed
 * or partial). Runs that did not review have no comparison (`null`).
 *
 * A finding the earlier review had and this one does not is **resolved** only when this run's agent that found it
 * finished, and the file was not left out of this review; otherwise the run could not tell (**not evaluated**).
 */
export function compareRuns(runs: readonly PullHistoryRun[]): Array<HistoryChangesDto | null> {
  let earlier: PullHistoryRun | undefined;
  return runs.map((entry) => {
    if (!isReviewed(entry.run.status)) return null;

    const current = entry.findings.map((f) => ({
      finding: asFinding(f, entry.run.headSha),
      source: f,
    }));

    if (!earlier) {
      earlier = entry;
      return {
        compared_to: null,
        new: current.map((c) => ref(c.source)).sort(byPlace),
        still_applicable: [],
        resolved: [],
        not_evaluated: [],
      };
    }

    const previous = new Map<PreviousFinding, StoredFinding>();
    for (const f of earlier.findings) previous.set(asPrevious(f), f);
    const { pairs, unmatched } = matchFindings(
      current.map((c) => c.finding),
      [...previous.keys()],
    );

    const agentsThatFinished = new Set(
      entry.agents.filter((a) => a.status === "ok").map((a) => a.agent),
    );
    const skipped = new Set(entry.run.skippedFiles.map((s) => s.path));

    const result: HistoryChangesDto = {
      compared_to: earlier.run.id,
      new: [],
      still_applicable: [],
      resolved: [],
      not_evaluated: [],
    };
    for (const c of current) {
      (pairs.has(c.finding) ? result.still_applicable : result.new).push(ref(c.source));
    }
    for (const gone of unmatched) {
      const source = previous.get(gone)!;
      const couldLook =
        agentsThatFinished.has(gone.agent) &&
        !(gone.filePath !== undefined && skipped.has(gone.filePath));
      (couldLook ? result.resolved : result.not_evaluated).push(ref(source));
    }
    for (const list of Object.values(result)) if (Array.isArray(list)) list.sort(byPlace);

    earlier = entry;
    return result;
  });
}
