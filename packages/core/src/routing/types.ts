import type { RunTrigger } from "@ai-pr-review/shared";

export type Trigger = RunTrigger;

/** The PR facts the guards need. Built from a webhook payload or from the PRs API. */
export interface PullRequestInfo {
  number: number;
  baseRef: string;
  headSha: string;
  isDraft: boolean;
  isFork: boolean;
}

/** What to do with this PR: review it (fully or summary-only) or skip it with a reason. */
export type RouteDecision =
  | { action: "review"; trigger: Trigger; pr: PullRequestInfo; depth: "full" | "summary_only" }
  | { action: "skip"; reason: string };
