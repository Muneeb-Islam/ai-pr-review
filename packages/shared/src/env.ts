import { z } from "zod";

/** Thrown when required environment variables are missing or invalid. Carries NAMES only, never values. */
export class EnvError extends Error {
  constructor(
    readonly missing: string[],
    readonly invalid: string[],
  ) {
    const parts: string[] = [];
    if (missing.length) parts.push(`Missing required environment variables: ${missing.join(", ")}`);
    if (invalid.length)
      parts.push(`Invalid environment variables (values not shown): ${invalid.join(", ")}`);
    super(parts.join("\n"));
    this.name = "EnvError";
  }
}

/**
 * Validates `source` (default `process.env`) against a zod object schema. Empty strings count as unset,
 * so `NAME=` in a .env file is treated as missing. Error messages contain variable names only.
 */
export function loadEnv<T extends z.ZodType>(
  schema: T,
  source: Record<string, string | undefined> = process.env,
): z.output<T> {
  const cleaned: Record<string, string> = {};
  for (const [key, value] of Object.entries(source)) {
    if (value !== undefined && value !== "") cleaned[key] = value;
  }
  const result = schema.safeParse(cleaned);
  if (result.success) return result.data;

  const missing = new Set<string>();
  const invalid = new Set<string>();
  for (const issue of result.error.issues) {
    const name = String(issue.path[0] ?? "(env)");
    if (cleaned[name] === undefined) missing.add(name);
    else invalid.add(name);
  }
  throw new EnvError([...missing].sort(), [...invalid].sort());
}

const port = z.coerce.number().int().min(1).max(65535);
const postgresUrl = z
  .string()
  .refine((v) => /^postgres(ql)?:\/\//.test(v), "must be a postgres:// URL");
const redisUrl = z.string().refine((v) => /^rediss?:\/\//.test(v), "must be a redis:// URL");

/**
 * Every server variable from design §6. Variables that only matter in later phases are optional
 * for now; each phase makes the ones it uses required in the app that needs them.
 */
export const serverEnvShape = {
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  HOST: z.string().min(1).default("127.0.0.1"),
  PORT: port.default(3000),
  DATABASE_URL: postgresUrl,
  REDIS_URL: redisUrl,
  PUBLIC_URL: z.url().default("http://localhost:5173"),
  RETENTION_DAYS: z.coerce.number().int().positive().default(90),
  QUOTA_RUNS_PER_DAY: z.coerce.number().int().positive().default(200),
  QUOTA_TOKENS_PER_DAY: z.coerce.number().int().positive().default(2_000_000),
  // Later phases (3: GitHub App, 4: auth and credentials):
  GITHUB_APP_ID: z.string().min(1).optional(),
  GITHUB_APP_PRIVATE_KEY: z.string().min(1).optional(),
  GITHUB_WEBHOOK_SECRET: z.string().min(1).optional(),
  GITHUB_CLIENT_ID: z.string().min(1).optional(),
  GITHUB_CLIENT_SECRET: z.string().min(1).optional(),
  SESSION_SECRET: z.string().min(1).optional(),
  ENCRYPTION_KEY: z.string().min(1).optional(),
} as const;

export const serverEnvSchema = z.object(serverEnvShape);
export type ServerEnv = z.output<typeof serverEnvSchema>;
