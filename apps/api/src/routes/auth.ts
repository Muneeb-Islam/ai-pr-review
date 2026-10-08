import { upsertUser } from "@ai-pr-review/db/system";
import { SESSION_COOKIE } from "../auth/sessions";
import { pkceChallenge, randomToken, safeEqual, sign, unsign } from "../auth/signing";
import { GitHubUnavailableError, OAuthExchangeError } from "../github/types";
import { sessionCookieOptions, type Handlers } from "../http/platform";

export const OAUTH_COOKIE = "aipr_oauth";
const OAUTH_COOKIE_PATH = "/auth/github";
const OAUTH_LABEL = "oauth-state";
/** How long the browser has to come back from GitHub. */
const OAUTH_STATE_TTL_MS = 10 * 60_000;
const AUTHORIZE_URL = "https://github.com/login/oauth/authorize";

/** Only a path on the dashboard: a leading single slash, nothing that could redirect to another site. */
export function safeReturnTo(raw: string | undefined): string | undefined {
  if (raw === undefined || raw.length > 500) return undefined;
  if (!raw.startsWith("/") || raw.startsWith("//")) return undefined;
  for (const char of raw) {
    if (char === "\\" || char.charCodeAt(0) < 0x20) return undefined;
  }
  return raw;
}

interface PendingLogin {
  /** The `state` parameter. */
  s: string;
  /** The PKCE code verifier. */
  v: string;
  /** Where to send the browser after sign-in. */
  r?: string;
  /** Expiry, epoch ms. */
  e: number;
}

const encodePending = (secret: string, pending: PendingLogin) =>
  sign(secret, OAUTH_LABEL, Buffer.from(JSON.stringify(pending)).toString("base64url"));

function decodePending(
  secret: string,
  cookie: string | undefined,
  now: number,
): PendingLogin | undefined {
  if (!cookie) return undefined;
  const body = unsign(secret, OAUTH_LABEL, cookie);
  if (!body) return undefined;
  try {
    const pending = JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as PendingLogin;
    const valid =
      typeof pending.s === "string" &&
      typeof pending.v === "string" &&
      typeof pending.e === "number" &&
      pending.e > now;
    return valid ? pending : undefined;
  } catch {
    return undefined;
  }
}

type AuthHandlers = Pick<Handlers, "login" | "loginCallback" | "logout">;

export const authHandlers: AuthHandlers = {
  /** Sends the browser to GitHub with a fresh `state` (CSRF for the flow) and PKCE challenge. */
  async login({ platform, reply, query }) {
    const { config } = platform;
    const now = (platform.now ?? (() => new Date()))().getTime();
    const state = randomToken();
    const verifier = randomToken();
    const returnTo = safeReturnTo(query.return_to);

    reply.setCookie(
      OAUTH_COOKIE,
      encodePending(config.sessionSecret, {
        s: state,
        v: verifier,
        ...(returnTo ? { r: returnTo } : {}),
        e: now + OAUTH_STATE_TTL_MS,
      }),
      { ...sessionCookieOptions(platform, OAUTH_STATE_TTL_MS / 1000), path: OAUTH_COOKIE_PATH },
    );

    const url = new URL(AUTHORIZE_URL);
    url.searchParams.set("client_id", config.githubClientId);
    url.searchParams.set("redirect_uri", `${config.apiPublicUrl}/auth/github/callback`);
    url.searchParams.set("state", state);
    url.searchParams.set("code_challenge", pkceChallenge(verifier));
    url.searchParams.set("code_challenge_method", "S256");
    reply.redirect(url.toString(), 302);
    return undefined;
  },

  /**
   * GitHub sends the browser back here. Every failure ends in a redirect to the dashboard's login page with a
   * short error code and creates no session. On success the previous session (if any) is deleted and a new one
   * is issued, so a session id from before sign-in never survives it (session fixation).
   */
  async loginCallback({ platform, request, reply, query }) {
    const { config, logger } = platform;
    const now = (platform.now ?? (() => new Date()))();
    const done = (path: string, error?: string) => {
      reply.clearCookie(OAUTH_COOKIE, { path: OAUTH_COOKIE_PATH });
      const target = new URL(path, config.publicUrl);
      if (error) target.searchParams.set("error", error);
      reply.redirect(target.toString(), 302);
      return undefined;
    };

    const pending = decodePending(
      config.sessionSecret,
      request.cookies[OAUTH_COOKIE],
      now.getTime(),
    );
    if (!pending) return done("/login", "invalid_state");
    if (query.error) return done("/login", "access_denied");
    if (!query.state || !safeEqual(query.state, pending.s) || !query.code) {
      return done("/login", "invalid_state");
    }

    try {
      const token = await platform.userApi.exchangeCode({
        code: query.code,
        redirectUri: `${config.apiPublicUrl}/auth/github/callback`,
        codeVerifier: pending.v,
      });
      // The token lives only until the access cache is filled; it is never stored or logged.
      const profile = await platform.userApi.getUser(token);
      const user = await upsertUser(platform.db, {
        githubUserId: profile.id,
        login: profile.login,
        ...(profile.avatarUrl ? { avatarUrl: profile.avatarUrl } : {}),
      });
      await platform.access.refreshAtLogin({ id: user.id, login: user.login }, token);

      const previous = platform.sessions.idOf(request.cookies[SESSION_COOKIE]);
      if (previous) await platform.sessions.end(previous);
      const started = await platform.sessions.start(user.id);
      reply.setCookie(
        SESSION_COOKIE,
        started.cookieValue,
        sessionCookieOptions(platform, started.maxAgeSeconds),
      );
      logger.info("Signed in", { user: user.id });
      return done(pending.r ?? "/");
    } catch (err) {
      if (err instanceof OAuthExchangeError) return done("/login", "invalid_code");
      if (err instanceof GitHubUnavailableError) return done("/login", "github_unavailable");
      throw err;
    }
  },

  async logout({ platform, reply, auth }) {
    await platform.sessions.end(auth.session.id);
    reply.clearCookie(SESSION_COOKIE, sessionCookieOptions(platform));
    return { ok: true as const };
  },
};
