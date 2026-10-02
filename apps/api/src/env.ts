import { loadEnv, serverEnvSchema } from "@ai-pr-review/shared";

/** What the API needs today. Later phases make more of the shared server variables required. */
export const apiEnvSchema = serverEnvSchema.pick({
  NODE_ENV: true,
  HOST: true,
  PORT: true,
  DATABASE_URL: true,
  REDIS_URL: true,
  PUBLIC_URL: true,
});

export type ApiEnv = ReturnType<typeof apiEnvSchema.parse>;

export const loadApiEnv = (source?: Record<string, string | undefined>): ApiEnv =>
  loadEnv(apiEnvSchema, source);
