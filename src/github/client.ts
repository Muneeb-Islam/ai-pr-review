import * as github from "@actions/github";
import { retry } from "@octokit/plugin-retry";
import { throttling } from "@octokit/plugin-throttling";
import type { PullRequestInfo } from "../events/types";
import type { Logger } from "../util/logger";

/** The slice of Octokit this module uses, so tests can pass a fake. */
export interface PullsClient {
  rest: {
    pulls: {
      get(params: { owner: string; repo: string; pull_number: number }): Promise<{
        data: {
          number: number;
          draft?: boolean;
          base: { ref: string; repo: { full_name: string } };
          head: { sha: string; repo: { full_name: string } | null };
        };
      }>;
    };
  };
}

const MAX_RATE_LIMIT_RETRIES = 2;

/** Octokit with retry on transient errors and throttling on primary/secondary rate limits. */
export function createOctokit(token: string, logger: Logger) {
  return github.getOctokit(
    token,
    {
      retry: { retries: 3 },
      throttle: {
        onRateLimit: (retryAfter, options, _octokit, retryCount) => {
          logger.warn("GitHub rate limit hit", {
            method: options.method,
            url: options.url,
            retryAfterSec: retryAfter,
            retryCount,
          });
          return retryCount < MAX_RATE_LIMIT_RETRIES;
        },
        onSecondaryRateLimit: (retryAfter, options, _octokit, retryCount) => {
          logger.warn("GitHub secondary rate limit hit", {
            method: options.method,
            url: options.url,
            retryAfterSec: retryAfter,
            retryCount,
          });
          return retryCount < MAX_RATE_LIMIT_RETRIES;
        },
      },
    },
    retry,
    throttling,
  );
}

export type Octokit = ReturnType<typeof createOctokit>;

export interface RepoRef {
  owner: string;
  repo: string;
}

/** Fetches a PR and reduces it to the facts the routing guards need. */
export async function fetchPullRequest(
  client: PullsClient,
  repo: RepoRef,
  prNumber: number,
): Promise<PullRequestInfo> {
  const { data } = await client.rest.pulls.get({ ...repo, pull_number: prNumber });
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
export async function verifyAuth(octokit: Octokit, logger: Logger): Promise<void> {
  try {
    const { data } = await octokit.rest.rateLimit.get();
    logger.info("GitHub authenticated", {
      rateLimitRemaining: data.resources.core.remaining,
    });
  } catch (err) {
    const status = (err as { status?: number }).status;
    if (status === 401) {
      throw new Error("GitHub rejected the token (401). Check the github_token input.", {
        cause: err,
      });
    }
    throw err;
  }
}
