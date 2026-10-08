import type { Finding, ResolvedConfig } from "@ai-pr-review/shared";
import type { ReviewContext } from "../context/types";
import { matchFindings, type PreviousFinding } from "../lifecycle/match";
import { meetsSeverity } from "../validation/severity";
import { renderInlineComment } from "./comment";

/** Why an accepted finding is listed in the summary only. */
export type SummaryOnlyReason =
  /** Draft pull request with `draft_behavior: summary_only` (FR-05). */
  | "draft"
  /** No file or no line to anchor a comment to. */
  | "no_location"
  /** A test suggestion that is not tied to a changed line at high confidence stays in the summary (AC-5). */
  | "category"
  /** Below the inline threshold (confidence and severity, FR-18). */
  | "below_threshold"
  /** More findings than `max_inline_comments`; the most severe were kept. */
  | "cap";

export interface InlineComment {
  finding: Finding;
  path: string;
  line: number;
  /** Set for a comment over several lines; `line` is then the last one. */
  startLine?: number;
  body: string;
}

export interface InlinePlan {
  comments: InlineComment[];
  summaryOnly: Array<{ finding: Finding; reason: SummaryOnlyReason }>;
  /**
   * Findings an inline comment already exists for (posted for this head SHA, or earlier for an older one): the
   * comment stays on the PR and is not posted again (FR-36). They are still findings of the run.
   */
  alreadyPosted: Finding[];
  /**
   * Findings whose path or line is not in the diff of the reviewed commit. Dropped and counted as suppressed
   * (`invalid_line`), like the validator does earlier; never posted and not listed in the summary (FR-17).
   */
  invalidPosition: Finding[];
}

/** A test suggestion becomes a line comment only when it is this sure; anything less stays in the summary. */
export const TEST_GAP_INLINE_CONFIDENCE = 0.9;

export interface PlanInput {
  context: ReviewContext;
  findings: readonly Finding[];
  config: ResolvedConfig;
  /** Fingerprints already posted for this head SHA, from the database (the context's `prior` is used too). */
  postedFingerprints?: ReadonlySet<string> | undefined;
  /**
   * The previous review's findings that have an inline comment on the pull request. A finding this run reports
   * again with a different fingerprint (a reworded title, a line that crossed a bucket boundary) is recognised
   * as one of them and not posted a second time.
   */
  previousPosted?: readonly PreviousFinding[] | undefined;
  dashboardUrl?: string | undefined;
}

/**
 * Decides which accepted findings become inline comments (FR-17, FR-18, FR-36). `findings` arrive most severe first
 * and the cap keeps that order. The path and line are checked against the diff of the reviewed head SHA that the
 * context was built from; the publisher has just confirmed the pull request still points at that commit, so the
 * diff cannot have changed since.
 */
export function planInline(input: PlanInput): InlinePlan {
  const { context, config } = input;
  const headSha = context.pr.headSha;
  const plan: InlinePlan = {
    comments: [],
    summaryOnly: [],
    alreadyPosted: [],
    invalidPosition: [],
  };

  // Idempotency (design §12): the same fingerprint for the same head SHA is never posted twice, whether the
  // database or the markers on GitHub remember it (a lost database write is covered by the markers). A comment
  // from an older head SHA is still on the pull request, so a finding that persists is not posted again either.
  const postedOnHead = new Set(input.postedFingerprints ?? []);
  for (const c of context.prior.comments)
    if (c.headSha === headSha) postedOnHead.add(c.fingerprint);
  const onPullRequest = new Set(context.prior.fingerprints);
  const continued = matchFindings(
    input.findings,
    (input.previousPosted ?? []).filter((p) => p.posted),
  ).pairs;

  const draftOff = context.pr.isDraft && config.review.draft_behavior !== "full";
  const max = config.review.max_inline_comments;

  for (const finding of input.findings) {
    if (postedOnHead.has(finding.id) || onPullRequest.has(finding.id) || continued.has(finding)) {
      plan.alreadyPosted.push(finding);
      continue;
    }
    if (draftOff) {
      plan.summaryOnly.push({ finding, reason: "draft" });
      continue;
    }
    if (finding.filePath === undefined || finding.startLine === undefined) {
      plan.summaryOnly.push({ finding, reason: "no_location" });
      continue;
    }
    if (finding.category === "test_gap" && finding.confidence < TEST_GAP_INLINE_CONFIDENCE) {
      plan.summaryOnly.push({ finding, reason: "category" });
      continue;
    }
    if (
      !meetsSeverity(finding.severity, config.review.minimum_severity) ||
      finding.confidence < config.review.minimum_confidence
    ) {
      plan.summaryOnly.push({ finding, reason: "below_threshold" });
      continue;
    }

    const { filePath: path, startLine } = finding;
    if (!context.isLineInDiff(path, startLine)) {
      plan.invalidPosition.push(finding);
      continue;
    }
    if (plan.comments.length >= max) {
      plan.summaryOnly.push({ finding, reason: "cap" });
      continue;
    }

    const endLine = finding.endLine;
    const lastLine =
      endLine !== undefined &&
      endLine > startLine &&
      context.isRangeInDiff(path, startLine, endLine)
        ? endLine
        : undefined;
    plan.comments.push({
      finding,
      path,
      line: lastLine ?? startLine,
      ...(lastLine !== undefined ? { startLine } : {}),
      body: renderInlineComment(finding, { headSha, dashboardUrl: input.dashboardUrl }),
    });
  }
  return plan;
}
