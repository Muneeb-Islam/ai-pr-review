import type { GitHubAppAuth } from "@ai-pr-review/core";
import {
  GitHubUnavailableError,
  type GitHubAppApi,
  type OrgRole,
  type RepoPermission,
} from "./types";

const statusOf = (err: unknown): number | undefined => (err as { status?: number }).status;

/** Refreshes cached access by asking GitHub as the App installation (Metadata: read is enough for repositories). */
export function createGitHubAppApi(auth: GitHubAppAuth): GitHubAppApi {
  let slug: Promise<string> | undefined;

  return {
    async getRepoPermission(githubInstallationId, repo, login): Promise<RepoPermission> {
      try {
        const client = await auth.getInstallationClient(githubInstallationId);
        const { data } = await client.request(
          "GET /repos/{owner}/{repo}/collaborators/{username}/permission",
          { owner: repo.owner, repo: repo.repo, username: login },
        );
        if (data.permission === "admin") return "admin";
        return data.permission === "none" ? "none" : "member";
      } catch (err) {
        if (statusOf(err) === 404) return "none";
        throw new GitHubUnavailableError();
      }
    },

    async getOrgRole(githubInstallationId, org, login): Promise<OrgRole> {
      try {
        const client = await auth.getInstallationClient(githubInstallationId);
        const { data } = await client.request("GET /orgs/{org}/memberships/{username}", {
          org,
          username: login,
        });
        if (data.state !== "active") return "none";
        return data.role === "admin" ? "admin" : "member";
      } catch (err) {
        if (statusOf(err) === 404) return "none";
        // 403: the App lacks the organization "Members: read" permission.
        if (statusOf(err) === 403) return "unknown";
        throw new GitHubUnavailableError();
      }
    },

    getAppSlug(): Promise<string> {
      // Cached on success only, so a transient failure is retried by the next caller.
      slug ??= auth
        .getAppClient()
        .request("GET /app")
        .then(({ data }) => {
          if (!data?.slug) throw new GitHubUnavailableError();
          return data.slug;
        })
        .catch((err: unknown) => {
          slug = undefined;
          throw err instanceof GitHubUnavailableError ? err : new GitHubUnavailableError();
        });
      return slug;
    },
  };
}
