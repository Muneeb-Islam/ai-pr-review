import { loadEnv, serverEnvSchema } from "@ai-pr-review/shared";
import { z } from "zod";

/** What the worker needs (design §6): the database and Redis, the GitHub App, the key ring and the tunables. */
export const workerEnvSchema = serverEnvSchema
  .pick({
    NODE_ENV: true,
    DATABASE_URL: true,
    REDIS_URL: true,
    GITHUB_APP_SLUG: true,
    PUBLIC_URL: true,
    ENCRYPTION_KEY_VERSION: true,
    ENCRYPTION_KEY_PREVIOUS: true,
    ENCRYPTION_KEY_PREVIOUS_VERSION: true,
    RETENTION_DAYS: true,
    RETENTION_INTERVAL_MINUTES: true,
    QUOTA_RUNS_PER_DAY: true,
    QUOTA_TOKENS_PER_DAY: true,
    WORKER_CONCURRENCY: true,
    WORKER_INSTALLATION_CONCURRENCY: true,
    RUN_HEARTBEAT_INTERVAL_SECONDS: true,
    RUN_STUCK_TIMEOUT_SECONDS: true,
    SWEEP_INTERVAL_SECONDS: true,
    JOB_MAX_ATTEMPTS: true,
    RUN_MAX_ATTEMPTS: true,
    SHUTDOWN_GRACE_SECONDS: true,
    LOG_FORMAT: true,
    AUDIT_RETENTION_DAYS: true,
    WEBHOOK_DELIVERY_RETENTION_DAYS: true,
    ACCESS_REFRESH_INTERVAL_MINUTES: true,
    SESSION_ABSOLUTE_TIMEOUT_HOURS: true,
  })
  .extend({
    // Optional in the shared schema (the api does not decrypt keys); the worker cannot run without them.
    GITHUB_APP_ID: z.string().min(1),
    GITHUB_APP_PRIVATE_KEY: z.string().min(1),
    ENCRYPTION_KEY: serverEnvSchema.shape.ENCRYPTION_KEY.unwrap(),
  });

export type WorkerEnv = ReturnType<typeof workerEnvSchema.parse>;

export const loadWorkerEnv = (source?: Record<string, string | undefined>): WorkerEnv =>
  loadEnv(workerEnvSchema, source);
