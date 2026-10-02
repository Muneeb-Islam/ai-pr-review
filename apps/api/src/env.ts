import { loadEnv, serverEnvSchema } from "@ai-pr-review/shared";
import { z } from "zod";

/** What the API needs today. Later phases make more of the shared server variables required. */
export const apiEnvSchema = serverEnvSchema
  .pick({
    NODE_ENV: true,
    HOST: true,
    PORT: true,
    DATABASE_URL: true,
    REDIS_URL: true,
    PUBLIC_URL: true,
    WEBHOOK_MAX_BODY_BYTES: true,
  })
  .extend({
    // Optional in the shared schema (the worker does not need them); the api cannot run without them.
    GITHUB_APP_ID: z.string().min(1),
    GITHUB_APP_PRIVATE_KEY: z.string().min(1),
    GITHUB_WEBHOOK_SECRET: z.string().min(1),
  });

export type ApiEnv = ReturnType<typeof apiEnvSchema.parse>;

export const loadApiEnv = (source?: Record<string, string | undefined>): ApiEnv =>
  loadEnv(apiEnvSchema, source);
