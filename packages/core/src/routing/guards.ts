import type { RepoConfig } from "@ai-pr-review/shared";
import type { PullRequestInfo, RouteDecision, Trigger } from "./types";

/**
 * Applies the fork, target-branch and draft rules (design §2, §8) in that order.
 * Pure: no I/O, so it can be unit tested exhaustively.
 *
 * Fork PRs are skipped unless an admin set `fork_prs: review` (decision 20). The App never executes PR
 * code and keeps provider keys server-side, so reviewing a fork is safe; skipping is the cost-abuse default.
 *
 * Needs only the routing settings, so it works before a provider is configured.
 */
export type RoutingConfig = Pick<RepoConfig, "fork_prs" | "review">;

export function decide(
  trigger: Trigger,
  pr: PullRequestInfo,
  config: RoutingConfig,
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
