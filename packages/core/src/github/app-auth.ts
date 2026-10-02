import { createPrivateKey, sign, type KeyObject } from "node:crypto";
import { registerSecret, type Logger } from "@ai-pr-review/shared";
import { Octokit } from "@octokit/core";
import { createGitHubClient, type GitHubClient } from "./client";

/** An App JWT may live at most 10 minutes; use less to leave room for clock drift. */
const JWT_LIFETIME_SECONDS = 9 * 60;
/** GitHub recommends backdating `iat` to allow for clock drift between us and GitHub. */
const JWT_BACKDATE_SECONDS = 60;
/** Installation tokens last one hour; refresh when less than this is left. */
const REFRESH_MARGIN_MS = 5 * 60 * 1000;

export interface GitHubAppCredentials {
  appId: string | number;
  /** PEM, PKCS#1 or PKCS#8. Literal backslash-n sequences (single-line env values) are accepted. */
  privateKey: string;
}

/** Turns an env-style key (literal backslash-n, optional surrounding quotes) into a usable PEM string. */
export function normalizePrivateKey(raw: string): string {
  let pem = raw.trim();
  if (
    pem.length > 1 &&
    ((pem.startsWith('"') && pem.endsWith('"')) || (pem.startsWith("'") && pem.endsWith("'")))
  ) {
    pem = pem.slice(1, -1);
  }
  return pem.replace(/\\n/g, "\n");
}

/** Parses the private key once; the error never includes key material. */
export function loadPrivateKey(raw: string): KeyObject {
  try {
    return createPrivateKey(normalizePrivateKey(raw));
  } catch {
    throw new Error("GITHUB_APP_PRIVATE_KEY is not a valid PEM private key.");
  }
}

const base64url = (input: Buffer | string): string => Buffer.from(input).toString("base64url");

/** RS256 JWT that authenticates as the App itself (design §4). Not logged, not stored. */
export function createAppJwt(
  credentials: { appId: string | number; privateKey: KeyObject },
  nowMs: number = Date.now(),
): string {
  const now = Math.floor(nowMs / 1000);
  const header = base64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const payload = base64url(
    JSON.stringify({
      iat: now - JWT_BACKDATE_SECONDS,
      exp: now + JWT_LIFETIME_SECONDS,
      iss: String(credentials.appId),
    }),
  );
  const signature = sign("RSA-SHA256", Buffer.from(`${header}.${payload}`), credentials.privateKey);
  return `${header}.${payload}.${base64url(signature)}`;
}

interface CachedToken {
  token: string;
  expiresAtMs: number;
}

export interface GitHubAppAuthOptions {
  logger: Logger;
  /** Test seams. */
  fetch?: typeof fetch;
  now?: () => number;
}

/**
 * App authentication: App JWT -> installation access token, cached in memory and refreshed shortly before
 * expiry. Concurrent callers for the same installation share one token request. Tokens are never persisted
 * or logged (they are also registered with the logger's redaction).
 */
export class GitHubAppAuth {
  private readonly key: KeyObject;
  private readonly cache = new Map<number, CachedToken>();
  private readonly inflight = new Map<number, Promise<string>>();
  private readonly now: () => number;

  constructor(
    private readonly credentials: GitHubAppCredentials,
    private readonly options: GitHubAppAuthOptions,
  ) {
    this.key = loadPrivateKey(credentials.privateKey);
    this.now = options.now ?? Date.now;
  }

  /** A valid installation token, from the cache when it has more than 5 minutes left. */
  async getInstallationToken(installationId: number): Promise<string> {
    const cached = this.cache.get(installationId);
    if (cached && cached.expiresAtMs - this.now() > REFRESH_MARGIN_MS) return cached.token;

    const pending = this.inflight.get(installationId);
    if (pending) return pending;

    const request = this.fetchToken(installationId).finally(() => {
      this.inflight.delete(installationId);
    });
    this.inflight.set(installationId, request);
    return request;
  }

  /** Forget a token, e.g. after GitHub answered 401 for it. */
  invalidate(installationId: number): void {
    this.cache.delete(installationId);
  }

  /** An Octokit authenticated as the installation (retry and throttling included). */
  async getInstallationClient(installationId: number): Promise<GitHubClient> {
    const token = await this.getInstallationToken(installationId);
    return createGitHubClient(
      token,
      this.options.logger,
      this.options.fetch ? { fetch: this.options.fetch } : {},
    );
  }

  private async fetchToken(installationId: number): Promise<string> {
    const jwt = createAppJwt({ appId: this.credentials.appId, privateKey: this.key }, this.now());
    registerSecret(jwt);
    const appClient = new Octokit({
      auth: jwt,
      ...(this.options.fetch ? { request: { fetch: this.options.fetch } } : {}),
    });
    const { data } = await appClient.request(
      "POST /app/installations/{installation_id}/access_tokens",
      { installation_id: installationId },
    );
    registerSecret(data.token);
    const expiresAtMs = Date.parse(data.expires_at);
    this.cache.set(installationId, {
      token: data.token,
      // If GitHub ever omits a parsable expiry, assume the documented one hour.
      expiresAtMs: Number.isFinite(expiresAtMs) ? expiresAtMs : this.now() + 60 * 60 * 1000,
    });
    this.options.logger.debug("Installation token created", { installation: installationId });
    return data.token;
  }
}
