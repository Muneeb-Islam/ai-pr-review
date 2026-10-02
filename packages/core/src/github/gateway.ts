import { CHECK_RUN_NAME } from "@ai-pr-review/shared";
import type { PullRequestInfo } from "../routing/types";
import type { GitHubAppAuth } from "./app-auth";
import type { RepoRef } from "./client";

export interface PullRequestSnapshot {
  pr: PullRequestInfo;
  baseSha: string;
  state: "open" | "closed";
}

/**
 * The GitHub calls the webhook handlers make. An interface so handler tests use a fake instead of the
 * network. The real implementation authenticates as the installation for every call.
 */
export interface GitHubGateway {
  /** Current state of a PR (for `/ai-review` comments and Check Run re-requests, which carry no PR data). */
  fetchPullRequest(
    githubInstallationId: number,
    repo: RepoRef,
    prNumber: number,
  ): Promise<PullRequestSnapshot>;
  /** Creates the Check Run in `queued` so the PR shows a pending check at once (AC-16). Returns its id. */
  createQueuedCheckRun(
    githubInstallationId: number,
    repo: RepoRef,
    input: { headSha: string; externalId: string; detailsUrl?: string },
  ): Promise<number>;
}

export function createGitHubGateway(auth: GitHubAppAuth): GitHubGateway {
  return {
    async fetchPullRequest(githubInstallationId, repo, prNumber) {
      const client = await auth.getInstallationClient(githubInstallationId);
      const { data } = await client.request("GET /repos/{owner}/{repo}/pulls/{pull_number}", {
        ...repo,
        pull_number: prNumber,
      });
      return {
        pr: {
          number: data.number,
          baseRef: data.base.ref,
          headSha: data.head.sha,
          isDraft: data.draft ?? false,
          isFork: data.head.repo === null || data.head.repo.full_name !== data.base.repo.full_name,
        },
        baseSha: data.base.sha,
        state: data.state === "open" ? "open" : "closed",
      };
    },

    async createQueuedCheckRun(githubInstallationId, repo, input) {
      const client = await auth.getInstallationClient(githubInstallationId);
      const { data } = await client.request("POST /repos/{owner}/{repo}/check-runs", {
        ...repo,
        name: CHECK_RUN_NAME,
        head_sha: input.headSha,
        status: "queued",
        external_id: input.externalId,
        ...(input.detailsUrl ? { details_url: input.detailsUrl } : {}),
        output: {
          title: "Review queued",
          summary: "The review is queued and will start shortly.",
        },
      });
      return Number(data.id);
    },
  };
}
