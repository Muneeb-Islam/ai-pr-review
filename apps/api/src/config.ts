import type { ApiEnv } from "./env";

/** Settings the HTTP layer needs, derived from the environment once at startup (tests build their own). */
export interface PlatformConfig {
  /** Dashboard URL: CORS origin and where sign-in sends the browser afterwards. */
  publicUrl: string;
  /** Public URL of this api: the OAuth callback lives under it. */
  apiPublicUrl: string;
  /** Cookies get `Secure` when the dashboard is served over https (browsers also accept it on localhost). */
  secureCookies: boolean;
  sessionSecret: string;
  githubClientId: string;
  githubClientSecret: string;
  sessionIdleMs: number;
  sessionAbsoluteMs: number;
  accessCacheTtlMs: number;
  rateLimitPerIpPerMinute: number;
  rateLimitPerUserPerMinute: number;
  quotas: { runsPerDay: number; tokensPerDay: number };
  /** How long finished runs are kept (PL-08); shown in the dashboard, enforced by the worker. */
  retentionDays: number;
  /** Lower-cased GitHub logins allowed to change the platform-wide AI setting. */
  platformAdmins?: readonly string[];
  /** URL slug of the GitHub App; looked up from GitHub when unset. */
  appSlug?: string;
}

export const isPlatformAdmin = (config: Pick<PlatformConfig, "platformAdmins">, login: string) =>
  (config.platformAdmins ?? []).includes(login.toLowerCase());

export const webOrigin = (config: Pick<PlatformConfig, "publicUrl">): string =>
  new URL(config.publicUrl).origin;

export function platformConfigFromEnv(env: ApiEnv): PlatformConfig {
  return {
    publicUrl: env.PUBLIC_URL,
    apiPublicUrl: env.API_PUBLIC_URL,
    secureCookies: env.NODE_ENV === "production" || env.PUBLIC_URL.startsWith("https://"),
    sessionSecret: env.SESSION_SECRET,
    githubClientId: env.GITHUB_CLIENT_ID,
    githubClientSecret: env.GITHUB_CLIENT_SECRET,
    sessionIdleMs: env.SESSION_IDLE_TIMEOUT_MINUTES * 60_000,
    sessionAbsoluteMs: env.SESSION_ABSOLUTE_TIMEOUT_HOURS * 3_600_000,
    accessCacheTtlMs: env.ACCESS_CACHE_TTL_SECONDS * 1000,
    rateLimitPerIpPerMinute: env.RATE_LIMIT_PER_IP_PER_MINUTE,
    rateLimitPerUserPerMinute: env.RATE_LIMIT_PER_USER_PER_MINUTE,
    quotas: { runsPerDay: env.QUOTA_RUNS_PER_DAY, tokensPerDay: env.QUOTA_TOKENS_PER_DAY },
    retentionDays: env.RETENTION_DAYS,
    platformAdmins: env.PLATFORM_ADMINS.split(",")
      .map((login) => login.trim().toLowerCase())
      .filter(Boolean),
    ...(env.GITHUB_APP_SLUG ? { appSlug: env.GITHUB_APP_SLUG } : {}),
  };
}
