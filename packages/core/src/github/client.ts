import type { Logger } from "@ai-pr-review/shared";
import { Octokit } from "@octokit/core";
import { retry } from "@octokit/plugin-retry";
import { throttling } from "@octokit/plugin-throttling";
import type { PullRequestInfo } from "../routing/types";

const ThrottledOctokit = Octokit.plugin(retry, throttling);
export type GitHubClient = InstanceType<typeof ThrottledOctokit>;

const MAX_RATE_LIMIT_RETRIES = 2;

/**
 * Octokit with retry on transient errors and throttling on primary/secondary rate limits.
 * `token` is an installation access token (or any token for local tooling). It is never logged.
 */
export function createGitHubClient(token: string, logger: Logger): GitHubClient {
  const onLimit =
    (message: string) =>
    (
      retryAfter: number,
      options: { method: string; url: string },
      _octokit: unknown,
      retryCount: number,
    ) => {
      logger.warn(message, {
        method: options.method,
        url: options.url,
        retryAfterSec: retryAfter,
        retryCount,
      });
      return retryCount < MAX_RATE_LIMIT_RETRIES;
    };

  return new ThrottledOctokit({
    auth: token,
    retry: { retries: 3 },
    throttle: {
      onRateLimit: onLimit("GitHub rate limit hit"),
      onSecondaryRateLimit: onLimit("GitHub secondary rate limit hit"),
    },
  });
}

export interface RepoRef {
  owner: string;
  repo: string;
}

interface PullData {
  number: number;
  draft?: boolean;
  base: { ref: string; repo: { full_name: string } };
  head: { sha: string; repo: { full_name: string } | null };
}

/** The slice of the client this module uses, so tests can pass a fake. */
export interface PullsClient {
  request(
    route: "GET /repos/{owner}/{repo}/pulls/{pull_number}",
    params: RepoRef & { pull_number: number },
  ): Promise<{ data: PullData }>;
}

/** Fetches a PR and reduces it to the facts the routing guards need. */
export async function fetchPullRequest(
  client: PullsClient,
  repo: RepoRef,
  prNumber: number,
): Promise<PullRequestInfo> {
  const { data } = await client.request("GET /repos/{owner}/{repo}/pulls/{pull_number}", {
    ...repo,
    pull_number: prNumber,
  });
  return {
    number: data.number,
    baseRef: data.base.ref,
    headSha: data.head.sha,
    isDraft: data.draft ?? false,
    isFork: data.head.repo === null || data.head.repo.full_name !== data.base.repo.full_name,
  };
}

/**
 * Confirms the token works. `GET /rate_limit` needs no permissions and does not
 * count against the rate limit. Throws a readable error on 401.
 */
export async function verifyAuth(client: GitHubClient, logger: Logger): Promise<void> {
  try {
    const { data } = await client.request("GET /rate_limit");
    logger.info("GitHub authenticated", { rateLimitRemaining: data.resources.core.remaining });
  } catch (err) {
    const status = (err as { status?: number }).status;
    if (status === 401) {
      throw new Error("GitHub rejected the token (401).", { cause: err });
    }
    throw err;
  }
}
