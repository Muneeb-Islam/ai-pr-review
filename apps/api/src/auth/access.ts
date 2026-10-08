// Authorisation (PL-13, design §9). Roles come from GitHub and are cached briefly:
//
//   installation role  admin  = owner of a personal account, or owner of the organisation
//                      viewer = any other user with access through the installation
//   repository role    admin  = the user is an admin of the repository on GitHub (organisation owners are)
//                      viewer = any other access
//
// The cache (`user_installations`, `user_repositories`) is filled at login with the user's own token. The
// token is not kept, so entries older than the TTL are re-checked on demand with the App's installation token
// (the user's repository permission, the user's organisation role). Anything that cannot be verified fails
// closed: no admin rights, or no access at all for a repository GitHub says the user no longer reaches.
import type { Database } from "@ai-pr-review/db";
import {
  getInstallationByGitHubId,
  getUserInstallationAccess,
  getUserRepoAccess,
  listUserInstallationAccess,
  listUserRepoAccess,
  replaceUserAccess,
  setUserInstallationRole,
  setUserRepoAccess,
  type InstallationAccess,
  type RepoAccess,
} from "@ai-pr-review/db/system";
import { listRepositories } from "@ai-pr-review/db";
import type { InstallationRole, Logger } from "@ai-pr-review/shared";
import { HttpError } from "../http/errors";
import {
  GitHubUnavailableError,
  type GitHubAppApi,
  type GitHubUserApi,
  type OrgRole,
} from "../github/types";

export interface AccessUser {
  id: string;
  login: string;
}

export interface AccessServiceDeps {
  db: Database;
  userApi: GitHubUserApi;
  appApi: GitHubAppApi;
  logger: Logger;
  ttlMs: number;
  now?: () => Date;
}

/** Stale cache entries re-verified per list call, and how many GitHub requests run at once. */
const MAX_REVERIFY_PER_REQUEST = 100;
const REVERIFY_CONCURRENCY = 8;

const sameLogin = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

export function installationRoleFor(
  account: { login: string; type: "user" | "organization" },
  user: { login: string },
  orgRole: OrgRole | undefined,
): InstallationRole {
  if (account.type === "user") return sameLogin(account.login, user.login) ? "admin" : "viewer";
  return orgRole === "admin" ? "admin" : "viewer";
}

const splitFullName = (fullName: string) => {
  const [owner = "", repo = ""] = fullName.split("/");
  return { owner, repo };
};

export class AccessService {
  private readonly now: () => Date;

  constructor(private readonly deps: AccessServiceDeps) {
    this.now = deps.now ?? (() => new Date());
  }

  /**
   * Login refresh: asks GitHub (with the user's token) which installations and repositories the user can
   * reach and with which role, and replaces the cache. Installations and repositories this platform has not
   * seen yet (their webhook has not arrived) are skipped; the next login picks them up.
   */
  async refreshAtLogin(user: AccessUser, token: string): Promise<void> {
    const { db, userApi, logger } = this.deps;
    const githubInstallations = await userApi.listInstallations(token);

    const installations: Array<{ installationId: string; role: InstallationRole }> = [];
    const repositories: Array<{ installationId: string; repoId: string; role: InstallationRole }> =
      [];

    for (const gh of githubInstallations) {
      const installation = await getInstallationByGitHubId(db, gh.id);
      if (!installation || installation.status !== "active") continue;

      let orgRole: OrgRole | undefined;
      if (gh.accountType === "organization") {
        try {
          orgRole = await userApi.getOrgRole(token, gh.accountLogin);
        } catch (err) {
          if (!(err instanceof GitHubUnavailableError)) throw err;
          orgRole = "unknown";
        }
      }
      const installationRole = installationRoleFor(
        { login: gh.accountLogin, type: gh.accountType },
        user,
        orgRole,
      );
      installations.push({ installationId: installation.id, role: installationRole });

      const known = new Map(
        (await listRepositories(db, [installation.id], { active: true })).map((r) => [
          r.githubRepoId,
          r.id,
        ]),
      );
      for (const repo of await userApi.listInstallationRepositories(token, gh.id)) {
        const repoId = known.get(repo.id);
        if (!repoId) continue;
        repositories.push({
          installationId: installation.id,
          repoId,
          role: installationRole === "admin" || repo.admin ? "admin" : "viewer",
        });
      }
    }

    await replaceUserAccess(db, user.id, { installations, repositories }, this.now());
    logger.info("Access refreshed at login", {
      installations: installations.length,
      repositories: repositories.length,
    });
  }

  /**
   * The user's access to one repository, or undefined if they have none. Entries older than the TTL are
   * re-verified with GitHub first; if GitHub cannot be asked the request fails (503) rather than guessing.
   */
  async getRepoAccess(user: AccessUser, repoId: string): Promise<RepoAccess | undefined> {
    const { db, appApi } = this.deps;
    const access = await getUserRepoAccess(db, user.id, repoId);
    if (!access) return undefined;
    if (this.now().getTime() - access.refreshedAt.getTime() <= this.deps.ttlMs) return access;

    let permission;
    try {
      permission = await appApi.getRepoPermission(
        access.githubInstallationId,
        splitFullName(access.fullName),
        user.login,
      );
    } catch (err) {
      return this.unavailable(err);
    }
    if (permission === "none") {
      await setUserRepoAccess(db, user.id, access.installationId, access.repoId, null);
      return undefined;
    }
    const role: InstallationRole = permission === "admin" ? "admin" : "viewer";
    const at = this.now();
    await setUserRepoAccess(db, user.id, access.installationId, access.repoId, role, at);
    return { ...access, role, refreshedAt: at };
  }

  /**
   * The user's access to one installation. The admin role is re-verified when stale: an organisation admin stays
   * admin while GitHub says so, otherwise the role drops to viewer. A viewer's access is only as good as the
   * repositories behind it (`getRepoAccess`, re-verified the same way): someone who has lost every repository
   * of the installation has lost the installation too, within the cache lifetime (AC-17).
   */
  async getInstallationAccess(
    user: AccessUser,
    installationId: string,
  ): Promise<InstallationAccess | undefined> {
    const access = await getUserInstallationAccess(this.deps.db, user.id, installationId);
    if (!access) return undefined;
    const verified = await this.verifyInstallation(user, access);
    if (verified.role === "admin") return verified;
    const repos = await this.listRepoAccess(user);
    return [...repos.values()].some((r) => r.installationId === installationId)
      ? verified
      : undefined;
  }

  /** Every installation the user can access, roles verified as in `getInstallationAccess`. */
  async listInstallationAccess(user: AccessUser): Promise<InstallationAccess[]> {
    const all = await listUserInstallationAccess(this.deps.db, user.id);
    const verified = await Promise.all(all.map((entry) => this.verifyInstallation(user, entry)));
    if (verified.every((entry) => entry.role === "admin")) return verified;
    const repos = await this.listRepoAccess(user);
    const reachable = new Set([...repos.values()].map((r) => r.installationId));
    return verified.filter(
      (entry) => entry.role === "admin" || reachable.has(entry.installationId),
    );
  }

  /**
   * Every repository the user may reach. Stale entries are re-verified (a bounded number per call, a few at a
   * time); entries that could not be verified are left out, never assumed.
   */
  async listRepoAccess(
    user: AccessUser,
  ): Promise<Map<string, { installationId: string; role: InstallationRole }>> {
    const { db, logger } = this.deps;
    const entries = await listUserRepoAccess(db, user.id);
    const now = this.now().getTime();
    const result = new Map<string, { installationId: string; role: InstallationRole }>();
    const stale: typeof entries = [];
    for (const entry of entries) {
      if (now - entry.refreshedAt.getTime() <= this.deps.ttlMs) {
        result.set(entry.repoId, { installationId: entry.installationId, role: entry.role });
      } else {
        stale.push(entry);
      }
    }

    const batch = stale.slice(0, MAX_REVERIFY_PER_REQUEST);
    if (stale.length > batch.length) {
      logger.warn("Some cached repository access could not be re-verified in this request", {
        skipped: stale.length - batch.length,
      });
    }
    for (let i = 0; i < batch.length; i += REVERIFY_CONCURRENCY) {
      await Promise.all(
        batch.slice(i, i + REVERIFY_CONCURRENCY).map(async (entry) => {
          try {
            const access = await this.getRepoAccess(user, entry.repoId);
            if (access) {
              result.set(access.repoId, {
                installationId: access.installationId,
                role: access.role,
              });
            }
          } catch (err) {
            if (!(err instanceof HttpError)) throw err; // GitHub unavailable: fail closed for this entry
          }
        }),
      );
    }
    return result;
  }

  private async verifyInstallation(
    user: AccessUser,
    access: InstallationAccess,
  ): Promise<InstallationAccess> {
    if (this.now().getTime() - access.refreshedAt.getTime() <= this.deps.ttlMs) return access;
    const { db, appApi } = this.deps;

    let role: InstallationRole;
    if (access.accountType === "user") {
      role = installationRoleFor({ login: access.accountLogin, type: "user" }, user, undefined);
    } else if (access.role !== "admin") {
      role = "viewer"; // nothing privileged to verify
    } else {
      try {
        const orgRole = await appApi.getOrgRole(
          access.githubInstallationId,
          access.accountLogin,
          user.login,
        );
        role = installationRoleFor(
          { login: access.accountLogin, type: "organization" },
          user,
          orgRole,
        );
      } catch (err) {
        return this.unavailable(err);
      }
    }
    const at = this.now();
    await setUserInstallationRole(db, user.id, access.installationId, role, at);
    return { ...access, role, refreshedAt: at };
  }

  private unavailable(err: unknown): never {
    if (err instanceof GitHubUnavailableError) {
      this.deps.logger.warn("Access check failed: GitHub unavailable");
      throw new HttpError(
        503,
        "access_check_failed",
        "Your access could not be verified with GitHub right now; try again shortly",
      );
    }
    throw err;
  }
}
