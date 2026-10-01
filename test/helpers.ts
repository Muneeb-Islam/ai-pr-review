import type { ResolvedConfig } from "../src/config/schema";
import { resolveConfig } from "../src/config/loader";
import type { PullRequestInfo } from "../src/events/types";

export function makeConfig(overrides: Record<string, unknown> = {}): ResolvedConfig {
  return resolveConfig({ provider: "deepseek", model: "test-model", ...overrides });
}

export function makePr(overrides: Partial<PullRequestInfo> = {}): PullRequestInfo {
  return {
    number: 7,
    baseRef: "main",
    headSha: "abc1234",
    isDraft: false,
    isFork: false,
    ...overrides,
  };
}

export function pullRequestPayload(
  opts: {
    action?: string;
    draft?: boolean;
    baseRef?: string;
    headRepo?: string | null;
    baseRepo?: string;
  } = {},
) {
  const baseRepo = opts.baseRepo ?? "acme/app";
  return {
    action: opts.action ?? "opened",
    pull_request: {
      number: 7,
      draft: opts.draft ?? false,
      base: { ref: opts.baseRef ?? "main", repo: { full_name: baseRepo } },
      head: {
        sha: "abc1234",
        repo: opts.headRepo === null ? null : { full_name: opts.headRepo ?? baseRepo },
      },
    },
  };
}

export function commentPayload(body: string, association: string, onPr = true) {
  return {
    action: "created",
    issue: { number: 7, ...(onPr ? { pull_request: { url: "x" } } : {}) },
    comment: { body, author_association: association },
  };
}
