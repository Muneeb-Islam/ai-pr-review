import type { ResolvedConfig } from "@ai-pr-review/shared";
import type { PullRequestInfo, RouteDecision, Trigger } from "./types";

/**
 * Applies the fork, target-branch and draft rules (design §2, §8) in that order.
 * Pure: no I/O, so it can be unit tested exhaustively.
 *
 * Fork PRs are always skipped for now, whatever `fork_prs` says: `read_only` for
 * maintainer-triggered runs is deferred to Phase 9 (design §8).
 */
export function decide(
  trigger: Trigger,
  pr: PullRequestInfo,
  config: ResolvedConfig,
): RouteDecision {
  if (pr.isFork && config.fork_prs === "skip") {
    return {
      action: "skip",
      reason: `PR #${pr.number} comes from a fork and fork_prs is "skip".`,
    };
  }

  const targets = config.review.target_branches;
  if (!targets.includes(pr.baseRef)) {
    return {
      action: "skip",
      reason: `PR #${pr.number} targets "${pr.baseRef}", which is not in review.target_branches [${targets.join(", ")}].`,
    };
  }

  if (pr.isDraft) {
    switch (config.review.draft_behavior) {
      case "skip":
        return {
          action: "skip",
          reason: `PR #${pr.number} is a draft and draft_behavior is "skip".`,
        };
      case "summary_only":
        return { action: "review", trigger, pr, depth: "summary_only" };
      case "full":
        break;
    }
  }
  return { action: "review", trigger, pr, depth: "full" };
}
