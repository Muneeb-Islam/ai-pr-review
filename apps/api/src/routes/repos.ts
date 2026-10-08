import { getLatestRunPerRepo, listRepositories, type Repo, type Run } from "@ai-pr-review/db";
import type { InstallationRole } from "@ai-pr-review/shared";
import { isPlatformAdmin } from "../config";
import type { Handlers } from "../http/platform";

type ReposHandlers = Pick<Handlers, "me" | "listRepos" | "getRepo">;

const iso = (date: Date) => date.toISOString();

export function toRepoDto(repo: Repo, role: InstallationRole, lastRun: Run | undefined) {
  return {
    id: repo.id,
    installation_id: repo.installationId,
    full_name: repo.fullName,
    default_branch: repo.defaultBranch,
    is_private: repo.isPrivate,
    enabled: repo.enabled,
    role,
    last_run: lastRun
      ? {
          id: lastRun.id,
          status: lastRun.status,
          pr_number: lastRun.prNumber,
          queued_at: iso(lastRun.queuedAt),
          finished_at: lastRun.finishedAt ? iso(lastRun.finishedAt) : null,
        }
      : null,
  };
}

export const repoHandlers: ReposHandlers = {
  async me({ platform, auth }) {
    const user = { id: auth.user.id, login: auth.user.login };
    const installations = await platform.access.listInstallationAccess(user);
    const slug =
      platform.config.appSlug ?? (await platform.appApi.getAppSlug().catch(() => undefined));
    return {
      user: { id: auth.user.id, login: auth.user.login, avatar_url: auth.user.avatarUrl },
      csrf_token: platform.sessions.csrfToken(auth.session),
      installations: installations.map((i) => ({
        id: i.installationId,
        account_login: i.accountLogin,
        account_type: i.accountType,
        role: i.role,
      })),
      platform_admin: isPlatformAdmin(platform.config, auth.user.login),
      install_url: slug
        ? `https://github.com/apps/${slug}/installations/new`
        : "https://github.com/settings/installations",
    };
  },

  async listRepos({ platform, auth, query }) {
    const access = await platform.access.listRepoAccess({
      id: auth.user.id,
      login: auth.user.login,
    });
    const installationIds = [...new Set([...access.values()].map((a) => a.installationId))];
    const repos = (
      await listRepositories(platform.db, installationIds, {
        active: true,
        ...(query.installation_id ? { installationId: query.installation_id } : {}),
        ...(query.search ? { search: query.search } : {}),
      })
    ).filter((repo) => access.get(repo.id)?.installationId === repo.installationId);

    const latest = new Map(
      (
        await getLatestRunPerRepo(
          platform.db,
          installationIds,
          repos.map((r) => r.id),
        )
      ).map((run) => [run.repoId, run]),
    );
    return {
      items: repos.map((repo) => toRepoDto(repo, access.get(repo.id)!.role, latest.get(repo.id))),
    };
  },

  async getRepo({ platform, repo, role }) {
    const [latest] = await getLatestRunPerRepo(platform.db, [repo.installationId], [repo.id]);
    return toRepoDto(repo, role, latest);
  },
};
