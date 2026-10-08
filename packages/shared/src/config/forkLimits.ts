// Stricter per-pull-request limits for pull requests from forks (AC-23, scope §2: "fork review needs quotas").
// A fork's author is a stranger: when an admin opts in to fork review, the review is capped so a hostile
// or merely enormous pull request costs little. The caps only ever lower a limit, never raise one.
import type { ResolvedConfig } from "./schema";

export const FORK_PR_LIMITS = {
  review: {
    max_changed_files: 15,
    max_patch_characters: 40_000,
    max_inline_comments: 8,
  },
  limits: {
    concurrency: 2,
    max_requests: 8,
    max_total_tokens: 120_000,
  },
} as const;

/** The configuration with the fork caps applied. Each value is the smaller of the configured one and the cap. */
export function applyForkLimits(config: ResolvedConfig): ResolvedConfig {
  const cap = FORK_PR_LIMITS;
  return {
    ...config,
    review: {
      ...config.review,
      max_changed_files: Math.min(config.review.max_changed_files, cap.review.max_changed_files),
      max_patch_characters: Math.min(
        config.review.max_patch_characters,
        cap.review.max_patch_characters,
      ),
      max_inline_comments: Math.min(
        config.review.max_inline_comments,
        cap.review.max_inline_comments,
      ),
    },
    limits: {
      ...config.limits,
      concurrency: Math.min(config.limits.concurrency, cap.limits.concurrency),
      max_requests: Math.min(config.limits.max_requests, cap.limits.max_requests),
      max_total_tokens: Math.min(config.limits.max_total_tokens, cap.limits.max_total_tokens),
    },
  };
}
