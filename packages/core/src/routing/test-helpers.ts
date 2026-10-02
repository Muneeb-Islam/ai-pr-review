import { mergeConfig, type RawConfig, type ResolvedConfig } from "@ai-pr-review/shared";
import type { PullRequestInfo } from "./types";

/** Dashboard-level settings plus optional overrides, resolved with defaults applied. */
export function makeConfig(overrides: RawConfig = {}): ResolvedConfig {
  return mergeConfig({ provider: "deepseek", model: "test-model", ...overrides });
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
