import { loadEnv, serverEnvSchema } from "@ai-pr-review/shared";

/** What the worker needs today. DATABASE_URL and the GitHub App variables are added in later phases. */
export const workerEnvSchema = serverEnvSchema.pick({ NODE_ENV: true, REDIS_URL: true });

export type WorkerEnv = ReturnType<typeof workerEnvSchema.parse>;

export const loadWorkerEnv = (source?: Record<string, string | undefined>): WorkerEnv =>
  loadEnv(workerEnvSchema, source);
