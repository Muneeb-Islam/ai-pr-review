export type Trigger = "pull_request" | "workflow_dispatch" | "comment_command";

/** The PR facts the guards need. Built from an event payload or from the PRs API. */
export interface PullRequestInfo {
  number: number;
  baseRef: string;
  headSha: string;
  isDraft: boolean;
  isFork: boolean;
}

/** What the workflow run should do with this PR. */
export type RouteDecision =
  | { action: "review"; trigger: Trigger; pr: PullRequestInfo; depth: "full" | "summary_only" }
  | { action: "skip"; reason: string };

/** Step 1: what the raw event tells us, before any API call. */
export type Classification =
  | { kind: "ignore"; reason: string }
  | { kind: "pr"; trigger: Trigger; pr: PullRequestInfo }
  /** Payload lacks PR details (dispatch, comment); caller fetches the PR, then calls `decide`. */
  | { kind: "needs_fetch"; trigger: Trigger; prNumber: number };
