import {
  getRepositoryByGitHubId,
  upsertRepository,
  type Installation,
  type Repo,
} from "@ai-pr-review/db";
import { getInstallationByGitHubId, upsertInstallationFromGitHub } from "@ai-pr-review/db/system";
import type { RepoPayload } from "./payloads";
import { ignored, type HandlerResult, type WebhookDeps } from "./types";

export const accountTypeOf = (type: string) => (type === "Organization" ? "organization" : "user");

export interface Target {
  installation: Installation;
  repo: Repo;
}

/**
 * Finds the installation and repository a PR-related event belongs to, or says why the event is ignored.
 *
 * An installation or repository we have never seen is created from the (signature-verified) payload: the
 * `installation` event may have been missed or may still be in flight when the first PR event arrives. One
 * we know to be gone is never revived here: a deactivated installation (suspended or deleted, AC-22) or a
 * repository removed from the installation creates no run.
 */
export async function resolveTarget(
  deps: WebhookDeps,
  githubInstallationId: number | undefined,
  repository: RepoPayload,
): Promise<Target | HandlerResult> {
  if (githubInstallationId === undefined) return ignored("no_installation");

  let installation = await getInstallationByGitHubId(deps.db, githubInstallationId);
  if (!installation) {
    installation = await upsertInstallationFromGitHub(deps.db, {
      githubInstallationId,
      accountLogin: repository.owner.login,
      accountType: accountTypeOf(repository.owner.type),
      status: "active",
    });
  }
  if (installation.status !== "active") return ignored("installation_inactive", installation.id);

  let repo = await getRepositoryByGitHubId(deps.db, [installation.id], repository.id);
  if (!repo) {
    repo = await upsertRepository(deps.db, installation.id, repositoryInput(repository));
  } else if (!repo.active) {
    return ignored("repository_inactive", installation.id);
  } else if (isStale(repo, repository)) {
    // Renames and a changed default branch are only visible on PR events; keep the row current.
    repo = await upsertRepository(deps.db, installation.id, repositoryInput(repository));
  }
  return { installation, repo };
}

const repositoryInput = (r: RepoPayload) => ({
  githubRepoId: r.id,
  fullName: r.full_name,
  ...(r.default_branch ? { defaultBranch: r.default_branch } : {}),
  isPrivate: r.private,
});

const isStale = (repo: Repo, r: RepoPayload): boolean =>
  repo.fullName !== r.full_name ||
  repo.isPrivate !== r.private ||
  (r.default_branch !== undefined && repo.defaultBranch !== r.default_branch);

export const isTarget = (value: Target | HandlerResult): value is Target => "repo" in value;
