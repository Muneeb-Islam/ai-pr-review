import type {
  FinalReviewSummary,
  Finding,
  FindingTracking,
  Logger,
  SuppressReason,
} from "@ai-pr-review/shared";
import type { EngineResult } from "../agents/types";
import type { ContextClient } from "../context/github";
import type { ReviewContext } from "../context/types";
import type { RepoRef } from "../github/client";
import type { PreviousFinding } from "../lifecycle/match";
import {
  classifyGitHubError,
  createReview,
  createReviewComment,
  fetchHeadSha,
  listReviewCommentIds,
  upsertSummaryComment,
} from "./github";
import { describeEnforcement, enforcementPolicy } from "./enforcement";
import { planInline, type InlineComment } from "./inline";
import { agentStates, renderSummary } from "./summary";
import { finalizeBody } from "./text";

export interface PublishReviewInput {
  /** Octokit authenticated as the installation (or a fake). */
  client: ContextClient;
  repo: RepoRef;
  context: ReviewContext;
  result: EngineResult;
  /** Link to the run in the dashboard (`PUBLIC_URL` + run id). */
  dashboardUrl?: string | undefined;
  /** `<slug>[bot]`; used to recognise the App's own summary comment. */
  appLogin?: string | undefined;
  /** Fingerprints already posted for this head SHA, from the database. */
  postedFingerprints?: ReadonlySet<string> | undefined;
  /** The previous review's findings that have an inline comment on the PR (see `planInline`). */
  previousPosted?: readonly PreviousFinding[] | undefined;
  /** What became of the previous review's findings (FR-37), for the summary. */
  tracking?: FindingTracking | undefined;
  /** What the Final Review pass did, for the summary. */
  finalReview?: FinalReviewSummary | undefined;
  /** False once the run is no longer ours (superseded, cancelled, recovered). Checked before every write. */
  stillCurrent?: (() => Promise<boolean>) | undefined;
  signal?: AbortSignal | undefined;
  logger?: Logger | undefined;
}

export interface PostedInline {
  finding: Finding;
  /** The review comment's id; absent only if GitHub's answer could not be matched to the finding. */
  githubId?: number | undefined;
}

export type PublishReport =
  /** The pull request moved to another commit; nothing was posted (design §12). */
  | { kind: "stale"; currentHeadSha: string }
  /** The run stopped being ours; nothing more was posted. */
  | { kind: "lost" }
  | {
      kind: "published";
      /** Inline comments now on the pull request because of this run. */
      inline: PostedInline[];
      /** Findings already posted for this head SHA by an earlier run or attempt. */
      alreadyPosted: Finding[];
      /** Dropped because their path or line is not in the diff: counted as suppressed, not summarised. */
      invalidPosition: Finding[];
      summary?: { id: number; created: boolean } | undefined;
      /** Non-sensitive sentences about what GitHub refused or could not do. */
      warnings: string[];
      /** Something the review wanted to post could not be posted. */
      degraded: boolean;
    };

const WARNINGS = {
  headUnknown:
    "GitHub could not confirm which commit the pull request points at, so no inline comments were posted.",
  denied:
    "GitHub refused the inline review: the App needs the Pull requests: write permission. The findings are listed in the summary instead.",
  unavailable:
    "GitHub was unavailable, so the inline review could not be posted. The findings are listed in the summary instead.",
  summaryDenied:
    "GitHub refused the summary comment: the App needs the Pull requests: write permission.",
  summaryUnavailable: "GitHub was unavailable, so the summary comment could not be posted.",
  idsUnknown: "Posted comments could not be matched to their ids; the run history lacks them.",
  rejected: (n: number) =>
    `GitHub rejected ${n} inline comment${n === 1 ? "" : "s"} (invalid position); ${n === 1 ? "it is" : "they are"} listed in the summary instead.`,
  dropped: (n: number) =>
    `${n} finding${n === 1 ? "" : "s"} pointed at lines outside the diff and ${n === 1 ? "was" : "were"} dropped.`,
};

function rethrowIfAborted(err: unknown, signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw err;
}

/**
 * Posts a finished review (FR-17 to FR-21, FR-33): the inline comments in one Pull Request Review with event
 * `COMMENT`, then the summary comment, created the first time and updated in place afterwards. GitHub errors
 * (403, 422, 5xx) never throw; they become warnings and the review publishes what it can. Only an abort throws.
 *
 * Order matters: the pull request's head is confirmed first, the review goes before the summary so the summary
 * can say which findings were really posted inline, and `stillCurrent` is checked before every write.
 */
export async function publishReview(input: PublishReviewInput): Promise<PublishReport> {
  const { client, repo, context, result, signal, logger } = input;
  const prNumber = context.pr.number;
  const headSha = context.pr.headSha;
  const warnings: string[] = [];
  let degraded = false;
  let inlineAllowed = true;

  // 1. Is the reviewed commit still the head? If not, a newer run is on its way and replaces this one.
  try {
    const current = await fetchHeadSha(client, repo, prNumber, signal);
    if (current !== headSha) return { kind: "stale", currentHeadSha: current };
  } catch (err) {
    rethrowIfAborted(err, signal);
    logger?.warn("Could not re-read the pull request head", { failure: classifyGitHubError(err) });
    warnings.push(WARNINGS.headUnknown);
    degraded = true;
    inlineAllowed = false;
  }

  // 2. Which findings become inline comments.
  const plan = planInline({
    context,
    findings: result.findings,
    config: context.config,
    postedFingerprints: input.postedFingerprints,
    previousPosted: input.previousPosted,
    dashboardUrl: input.dashboardUrl,
  });
  if (plan.invalidPosition.length > 0) warnings.push(WARNINGS.dropped(plan.invalidPosition.length));

  // 3. The review.
  const inline: PostedInline[] = [];
  const notPosted = new Set<string>();
  const comments: InlineComment[] = inlineAllowed ? plan.comments : [];
  for (const c of inlineAllowed ? [] : plan.comments) notPosted.add(c.finding.id);

  if (comments.length > 0) {
    if (input.stillCurrent && !(await input.stillCurrent())) return { kind: "lost" };
    try {
      const reviewId = await createReview(client, repo, prNumber, { headSha, comments }, signal);
      let ids = new Map<string, number>();
      try {
        ids = await listReviewCommentIds(client, repo, prNumber, reviewId, signal);
      } catch (err) {
        rethrowIfAborted(err, signal);
        warnings.push(WARNINGS.idsUnknown);
      }
      for (const c of comments)
        inline.push({ finding: c.finding, githubId: ids.get(c.finding.id) });
    } catch (err) {
      rethrowIfAborted(err, signal);
      const failure = classifyGitHubError(err);
      logger?.warn("The inline review was refused", { failure, comments: comments.length });
      if (failure === "invalid" || failure === "missing") {
        // One bad position rejects the whole review (422). Post the comments one by one so the good ones land.
        let rejected = 0;
        let stopped = false;
        for (const c of comments) {
          if (stopped) {
            notPosted.add(c.finding.id);
            continue;
          }
          if (input.stillCurrent && !(await input.stillCurrent())) return { kind: "lost" };
          try {
            const id = await createReviewComment(
              client,
              repo,
              prNumber,
              { headSha, comment: c },
              signal,
            );
            inline.push({ finding: c.finding, githubId: id });
          } catch (inner) {
            rethrowIfAborted(inner, signal);
            notPosted.add(c.finding.id);
            const innerFailure = classifyGitHubError(inner);
            if (innerFailure === "denied" || innerFailure === "unavailable") {
              stopped = true;
              warnings.push(innerFailure === "denied" ? WARNINGS.denied : WARNINGS.unavailable);
            } else {
              rejected += 1;
            }
          }
        }
        if (rejected > 0) warnings.push(WARNINGS.rejected(rejected));
      } else {
        for (const c of comments) notPosted.add(c.finding.id);
        warnings.push(failure === "denied" ? WARNINGS.denied : WARNINGS.unavailable);
      }
      degraded = true;
    }
  }

  // 4. The summary.
  const inlineIds = new Set([
    ...inline.map((p) => p.finding.id),
    ...plan.alreadyPosted.map((f) => f.id),
  ]);
  const dropped = new Set(plan.invalidPosition.map((f) => f.id));
  const suppressedCounts = { ...result.suppressedCounts } as Partial<
    Record<SuppressReason, number>
  >;
  if (plan.invalidPosition.length > 0) {
    suppressedCounts.invalid_line =
      (suppressedCounts.invalid_line ?? 0) + plan.invalidPosition.length;
  }

  if (input.stillCurrent && !(await input.stillCurrent())) return { kind: "lost" };
  const shown = result.findings.filter((f) => !dropped.has(f.id));
  const body = finalizeBody(
    renderSummary({
      status: result.status,
      headSha,
      reason: result.reason,
      limitReason: context.limits.status === "limited" ? context.limits.reason : undefined,
      findings: shown.map((finding) => ({ finding, inline: inlineIds.has(finding.id) })),
      suppressedCounts,
      observations: result.observations,
      agents: agentStates(context.config, result.agentRuns),
      coverage: result.coverage,
      skippedFiles: context.skippedFiles,
      warnings: [...result.warnings, ...warnings],
      isDraft: context.pr.isDraft,
      inlineCapped: plan.summaryOnly.filter((s) => s.reason === "cap").length,
      dashboardUrl: input.dashboardUrl,
      tracking: input.tracking,
      finalReview: input.finalReview,
      enforcement: describeEnforcement({
        policy: enforcementPolicy(context.config.review),
        status: result.status,
        findings: shown,
      }),
    }),
    60_000,
  );

  let summary: { id: number; created: boolean } | undefined;
  try {
    summary = await upsertSummaryComment(
      client,
      repo,
      prNumber,
      { body, existingId: context.prior.summaryCommentId, appLogin: input.appLogin },
      signal,
    );
  } catch (err) {
    rethrowIfAborted(err, signal);
    const failure = classifyGitHubError(err);
    logger?.warn("The summary comment was refused", { failure });
    warnings.push(failure === "denied" ? WARNINGS.summaryDenied : WARNINGS.summaryUnavailable);
    degraded = true;
  }

  logger?.info("Review published", {
    inline: inline.length,
    alreadyPosted: plan.alreadyPosted.length,
    notPosted: notPosted.size,
    dropped: plan.invalidPosition.length,
    summary: summary ? (summary.created ? "created" : "updated") : "none",
  });
  return {
    kind: "published",
    inline,
    alreadyPosted: plan.alreadyPosted,
    invalidPosition: plan.invalidPosition,
    summary,
    warnings,
    degraded,
  };
}
