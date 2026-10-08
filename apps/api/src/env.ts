import { loadEnv, serverEnvSchema } from "@ai-pr-review/shared";
import { z } from "zod";

/** What the API needs. The worker-only and later-phase variables stay in the shared schema. */
export const apiEnvSchema = serverEnvSchema
  .pick({
    NODE_ENV: true,
    HOST: true,
    PORT: true,
    DATABASE_URL: true,
    REDIS_URL: true,
    PUBLIC_URL: true,
    API_PUBLIC_URL: true,
    WEBHOOK_MAX_BODY_BYTES: true,
    GITHUB_APP_SLUG: true,
    ENCRYPTION_KEY_VERSION: true,
    ENCRYPTION_KEY_PREVIOUS: true,
    ENCRYPTION_KEY_PREVIOUS_VERSION: true,
    SESSION_IDLE_TIMEOUT_MINUTES: true,
    SESSION_ABSOLUTE_TIMEOUT_HOURS: true,
    ACCESS_CACHE_TTL_SECONDS: true,
    RATE_LIMIT_PER_IP_PER_MINUTE: true,
    RATE_LIMIT_PER_USER_PER_MINUTE: true,
    RETENTION_DAYS: true,
    QUOTA_RUNS_PER_DAY: true,
    QUOTA_TOKENS_PER_DAY: true,
    JOB_MAX_ATTEMPTS: true,
    RUN_STUCK_TIMEOUT_SECONDS: true,
    LOG_FORMAT: true,
    METRICS_TOKEN: true,
    WEBHOOK_RATE_LIMIT_PER_MINUTE: true,
    WEBHOOK_BAD_SIGNATURE_LIMIT_PER_MINUTE: true,
    WEBHOOK_INSTALLATION_LIMIT_PER_MINUTE: true,
    QUEUE_MAX_QUEUED_PER_INSTALLATION: true,
    QUEUE_MAX_QUEUED_GLOBAL: true,
  })
  .extend({
    // Optional in the shared schema (the worker does not need them); the api cannot run without them.
    GITHUB_APP_ID: z.string().min(1),
    GITHUB_APP_PRIVATE_KEY: z.string().min(1),
    GITHUB_WEBHOOK_SECRET: z.string().min(1),
    GITHUB_CLIENT_ID: z.string().min(1),
    GITHUB_CLIENT_SECRET: z.string().min(1),
    SESSION_SECRET: serverEnvSchema.shape.SESSION_SECRET.unwrap(),
    ENCRYPTION_KEY: serverEnvSchema.shape.ENCRYPTION_KEY.unwrap(),
    /** Set when the api runs behind a reverse proxy, so client IPs (rate limiting) come from X-Forwarded-For. */
    /** Comma-separated GitHub logins that may change the platform-wide AI setting. Empty: nobody. */
    PLATFORM_ADMINS: z.string().default(""),
    TRUST_PROXY: z.stringbool().default(false),
  });

export type ApiEnv = ReturnType<typeof apiEnvSchema.parse>;

export const loadApiEnv = (source?: Record<string, string | undefined>): ApiEnv =>
  loadEnv(apiEnvSchema, source);
