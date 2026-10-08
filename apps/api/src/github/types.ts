// The GitHub calls the auth module needs, as interfaces so tests run without the network.

export interface GitHubProfile {
  id: number;
  login: string;
  avatarUrl: string | null;
}

export interface UserInstallation {
  id: number;
  accountLogin: string;
  accountType: "user" | "organization";
}

export interface UserRepository {
  id: number;
  fullName: string;
  /** GitHub admin permission on the repository for this user. */
  admin: boolean;
}

/** Membership of an organisation: `unknown` means GitHub would not tell us (missing App permission). */
export type OrgRole = "admin" | "member" | "none" | "unknown";

/** Calls made with the signed-in user's own token. The token exists only for the duration of the login. */
export interface GitHubUserApi {
  exchangeCode(input: { code: string; redirectUri: string; codeVerifier: string }): Promise<string>;
  getUser(token: string): Promise<GitHubProfile>;
  listInstallations(token: string): Promise<UserInstallation[]>;
  listInstallationRepositories(token: string, installationId: number): Promise<UserRepository[]>;
  getOrgRole(token: string, org: string): Promise<OrgRole>;
}

export type RepoPermission = "admin" | "member" | "none";

/** Calls made as the App installation, for refreshing cached access without the user's token. */
export interface GitHubAppApi {
  getRepoPermission(
    githubInstallationId: number,
    repo: { owner: string; repo: string },
    login: string,
  ): Promise<RepoPermission>;
  getOrgRole(githubInstallationId: number, org: string, login: string): Promise<OrgRole>;
  /** `https://github.com/apps/<slug>`: the slug of this App. */
  getAppSlug(): Promise<string>;
}

/** GitHub could not be asked (outage, rate limit, revoked token). The cause is not carried: it can name tokens. */
export class GitHubUnavailableError extends Error {
  constructor(message = "GitHub could not be reached") {
    super(message);
    this.name = "GitHubUnavailableError";
  }
}

/** The authorization code was refused (expired, reused, wrong redirect URI). */
export class OAuthExchangeError extends Error {
  constructor() {
    super("GitHub refused the authorization code");
    this.name = "OAuthExchangeError";
  }
}
