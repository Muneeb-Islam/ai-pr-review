import {
  GitHubUnavailableError,
  OAuthExchangeError,
  type GitHubProfile,
  type GitHubUserApi,
  type OrgRole,
  type UserInstallation,
  type UserRepository,
} from "./types";

const GITHUB = "https://github.com";
const API = "https://api.github.com";
const REQUEST_TIMEOUT_MS = 10_000;
const PAGE_SIZE = 100;
/** Pages fetched per listing: 2,000 items. Beyond that a user simply sees the first 2,000 repositories. */
const MAX_PAGES = 20;

export interface GitHubUserApiOptions {
  clientId: string;
  clientSecret: string;
  fetch?: typeof fetch;
}

/**
 * GitHub OAuth (user-to-server) and the few user-scoped REST calls the dashboard needs. The user's token is
 * passed in per call and never stored or logged by this module.
 */
export function createGitHubUserApi(options: GitHubUserApiOptions): GitHubUserApi {
  const doFetch = options.fetch ?? fetch;

  async function request(url: string, init: RequestInit): Promise<Response> {
    try {
      return await doFetch(url, { ...init, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
    } catch {
      throw new GitHubUnavailableError();
    }
  }

  async function get(token: string, path: string): Promise<Response> {
    return request(`${API}${path}`, {
      headers: {
        accept: "application/vnd.github+json",
        authorization: `Bearer ${token}`,
        "x-github-api-version": "2022-11-28",
        "user-agent": "ai-pr-review",
      },
    });
  }

  async function getJson<T>(token: string, path: string): Promise<T> {
    const response = await get(token, path);
    if (!response.ok) throw new GitHubUnavailableError(`GitHub answered ${response.status}`);
    return (await response.json()) as T;
  }

  async function paginate<T>(
    token: string,
    path: string,
    pick: (page: unknown) => T[],
  ): Promise<T[]> {
    const items: T[] = [];
    for (let page = 1; page <= MAX_PAGES; page++) {
      const separator = path.includes("?") ? "&" : "?";
      const batch = pick(
        await getJson(token, `${path}${separator}per_page=${PAGE_SIZE}&page=${page}`),
      );
      items.push(...batch);
      if (batch.length < PAGE_SIZE) break;
    }
    return items;
  }

  return {
    async exchangeCode({ code, redirectUri, codeVerifier }) {
      const response = await request(`${GITHUB}/login/oauth/access_token`, {
        method: "POST",
        headers: { accept: "application/json", "content-type": "application/json" },
        body: JSON.stringify({
          client_id: options.clientId,
          client_secret: options.clientSecret,
          code,
          redirect_uri: redirectUri,
          code_verifier: codeVerifier,
        }),
      });
      if (response.status >= 500) throw new GitHubUnavailableError();
      const body = (await response.json().catch(() => ({}))) as {
        access_token?: unknown;
        error?: unknown;
      };
      // GitHub answers 200 with an `error` field for a bad or reused code.
      if (!response.ok || typeof body.access_token !== "string" || body.access_token === "") {
        throw new OAuthExchangeError();
      }
      return body.access_token;
    },

    async getUser(token): Promise<GitHubProfile> {
      const user = await getJson<{ id: number; login: string; avatar_url?: string | null }>(
        token,
        "/user",
      );
      return { id: user.id, login: user.login, avatarUrl: user.avatar_url ?? null };
    },

    async listInstallations(token): Promise<UserInstallation[]> {
      type Raw = { id: number; account: { login: string; type: string } | null };
      const raw = await paginate<Raw>(
        token,
        "/user/installations",
        (page) => (page as { installations?: Raw[] }).installations ?? [],
      );
      return raw.flatMap((i) =>
        i.account
          ? [
              {
                id: i.id,
                accountLogin: i.account.login,
                accountType:
                  i.account.type === "Organization" ? ("organization" as const) : ("user" as const),
              },
            ]
          : [],
      );
    },

    async listInstallationRepositories(token, installationId): Promise<UserRepository[]> {
      type Raw = { id: number; full_name: string; permissions?: { admin?: boolean } };
      const raw = await paginate<Raw>(
        token,
        `/user/installations/${installationId}/repositories`,
        (page) => (page as { repositories?: Raw[] }).repositories ?? [],
      );
      return raw.map((r) => ({
        id: r.id,
        fullName: r.full_name,
        admin: r.permissions?.admin === true,
      }));
    },

    async getOrgRole(token, org): Promise<OrgRole> {
      const response = await get(token, `/user/memberships/orgs/${encodeURIComponent(org)}`);
      if (response.status === 404) return "none";
      // 403: the App was not granted the organization "Members: read" permission. The role is not knowable.
      if (response.status === 403) return "unknown";
      if (!response.ok) throw new GitHubUnavailableError(`GitHub answered ${response.status}`);
      const body = (await response.json()) as { role?: string; state?: string };
      if (body.state !== "active") return "none";
      return body.role === "admin" ? "admin" : "member";
    },
  };
}
