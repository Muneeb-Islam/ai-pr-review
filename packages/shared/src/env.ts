import { readFileSync } from "node:fs";
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

/** Suffix that turns `NAME` into the variable that holds the path of a file with its value. */
export const FILE_SUFFIX = "_FILE";

/**
 * Secrets can come from a file instead of the environment (Docker and Kubernetes secrets): `NAME_FILE=/run/secrets/x`
 * supplies `NAME` when `NAME` itself is not set. The file's content is used with trailing newlines removed. A
 * file that cannot be read makes `NAME_FILE` invalid (by name; the path and the error are never shown).
 */
export function resolveFileSecrets(
  source: Record<string, string | undefined>,
  names: ReadonlySet<string>,
): {
  values: Record<string, string>;
  unreadable: string[];
} {
  const values: Record<string, string> = {};
  const unreadable: string[] = [];
  for (const [key, value] of Object.entries(source)) {
    if (value !== undefined && value !== "") values[key] = value;
  }
  for (const [key, path] of Object.entries(values)) {
    if (!key.endsWith(FILE_SUFFIX) || key.length === FILE_SUFFIX.length) continue;
    const name = key.slice(0, -FILE_SUFFIX.length);
    // Only variables the schema knows: an unrelated `SOMETHING_FILE` in the environment is none of our business.
    if (!names.has(name)) continue;
    if (values[name] !== undefined) continue; // an explicit variable wins over its file
    try {
      const content = readFileSync(path, "utf8").replace(/[\r\n]+$/, "");
      if (content !== "") values[name] = content;
    } catch {
      unreadable.push(key);
    }
  }
  return { values, unreadable };
}

/**
 * Validates `source` (default `process.env`) against a zod object schema. Empty strings count as unset,
 * so `NAME=` in a .env file is treated as missing. `NAME_FILE` can stand in for `NAME` (see `resolveFileSecrets`).
 * Error messages contain variable names only.
 */
export function loadEnv<T extends z.ZodType>(
  schema: T,
  source: Record<string, string | undefined> = process.env,
): z.output<T> {
  const names = new Set(schema instanceof z.ZodObject ? Object.keys(schema.shape) : []);
  const { values: cleaned, unreadable } = resolveFileSecrets(source, names);
  const result = schema.safeParse(cleaned);
  if (result.success && unreadable.length === 0) return result.data;

  const missing = new Set<string>();
  const invalid = new Set<string>(unreadable);
  if (!result.success) {
    for (const issue of result.error.issues) {
      const name = String(issue.path[0] ?? "(env)");
      if (cleaned[name] === undefined) missing.add(name);
      else invalid.add(name);
    }
  }
  throw new EnvError([...missing].sort(), [...invalid].sort());
}

/** 32 bytes as base64 (standard or url-safe alphabet). */
export function isBase64Key32(value: string): boolean {
  return /^[A-Za-z0-9+/_-]+={0,2}$/.test(value) && Buffer.from(value, "base64").length === 32;
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
  /** Finished runs older than this are deleted with their findings, comments and feedback (PL-08). */
  RETENTION_DAYS: z.coerce.number().int().positive().default(90),
  /** How often each worker runs the retention cleanup (it is idempotent, so several workers may). */
  RETENTION_INTERVAL_MINUTES: z.coerce.number().int().positive().default(360),
  QUOTA_RUNS_PER_DAY: z.coerce.number().int().positive().default(200),
  QUOTA_TOKENS_PER_DAY: z.coerce.number().int().positive().default(2_000_000),
  /** Largest webhook body the api accepts (GitHub's own cap is 25 MB; real events are far smaller). */
  WEBHOOK_MAX_BODY_BYTES: z.coerce
    .number()
    .int()
    .positive()
    .default(5 * 1024 * 1024),
  /** Public base URL of the api: the OAuth callback is `${API_PUBLIC_URL}/auth/github/callback`. */
  API_PUBLIC_URL: z.url().default("http://localhost:3000"),
  // GitHub App (required by the api since Phase 3) and sign-in / credentials (Phase 4):
  GITHUB_APP_ID: z.string().min(1).optional(),
  GITHUB_APP_PRIVATE_KEY: z.string().min(1).optional(),
  GITHUB_WEBHOOK_SECRET: z.string().min(1).optional(),
  /** URL slug of the App (github.com/apps/<slug>), for the "Install the App" link. Looked up if unset. */
  GITHUB_APP_SLUG: z.string().min(1).optional(),
  GITHUB_CLIENT_ID: z.string().min(1).optional(),
  GITHUB_CLIENT_SECRET: z.string().min(1).optional(),
  /** Signs the session and OAuth-state cookies and derives CSRF tokens. At least 32 characters. */
  SESSION_SECRET: z.string().min(32, "must be at least 32 characters").optional(),
  /** 32 random bytes, base64. Wraps the per-record data keys of provider credentials. */
  ENCRYPTION_KEY: z
    .string()
    .refine(isBase64Key32, "must be 32 bytes encoded as base64 (openssl rand -base64 32)")
    .optional(),
  /** Version stamped on records wrapped with `ENCRYPTION_KEY`; raise it when you rotate the key. */
  ENCRYPTION_KEY_VERSION: z.coerce.number().int().positive().default(1),
  /** The key it replaced, kept so existing records stay readable until the rotation script re-wraps them. */
  ENCRYPTION_KEY_PREVIOUS: z
    .string()
    .refine(isBase64Key32, "must be 32 bytes encoded as base64")
    .optional(),
  ENCRYPTION_KEY_PREVIOUS_VERSION: z.coerce.number().int().positive().optional(),
  /** Sessions end after this long without a request... */
  SESSION_IDLE_TIMEOUT_MINUTES: z.coerce.number().int().positive().default(120),
  /** ...and in any case this long after sign-in. */
  SESSION_ABSOLUTE_TIMEOUT_HOURS: z.coerce.number().int().positive().default(168),
  /** How long cached GitHub access (roles, repositories) is trusted before it is checked again. */
  ACCESS_CACHE_TTL_SECONDS: z.coerce.number().int().positive().default(600),
  RATE_LIMIT_PER_IP_PER_MINUTE: z.coerce.number().int().positive().default(300),
  RATE_LIMIT_PER_USER_PER_MINUTE: z.coerce.number().int().positive().default(120),
  // Worker (Phase 8, design §7). All optional; the defaults suit one small worker.
  /** Reviews a worker process runs at once (global cap). */
  WORKER_CONCURRENCY: z.coerce.number().int().positive().default(4),
  /** Reviews of one installation running at once across all workers (fairness). */
  WORKER_INSTALLATION_CONCURRENCY: z.coerce.number().int().positive().default(2),
  /** A running review proves it is alive this often. */
  RUN_HEARTBEAT_INTERVAL_SECONDS: z.coerce.number().int().positive().default(10),
  /** A running review without a heartbeat for this long is considered stuck and recovered by the sweeper. */
  RUN_STUCK_TIMEOUT_SECONDS: z.coerce.number().int().positive().default(120),
  /** How often each worker looks for stuck runs and queued runs that lost their job. */
  SWEEP_INTERVAL_SECONDS: z.coerce.number().int().positive().default(30),
  /** Attempts per job for infrastructure failures (Redis, database, GitHub 5xx), with exponential backoff. */
  JOB_MAX_ATTEMPTS: z.coerce.number().int().positive().default(5),
  /** Times a run may be started in total (first try plus recoveries) before it is failed. */
  RUN_MAX_ATTEMPTS: z.coerce.number().int().positive().default(3),
  /** On shutdown the worker waits this long for running reviews before it hands them back to the queue. */
  SHUTDOWN_GRACE_SECONDS: z.coerce.number().int().nonnegative().default(30),
  // Hardening and operations (Phase 15, design §9 and §16).
  /** `json` (one object per line, for log collectors) or `text` (readable). Default: json in production, else text. */
  LOG_FORMAT: z.enum(["text", "json"]).optional(),
  /** Bearer token for `GET /metrics`. Without it the endpoint does not exist (404). At least 16 characters. */
  METRICS_TOKEN: z.string().min(16, "must be at least 16 characters").optional(),
  /** Webhook requests per minute from one client IP. GitHub sends from a small set of addresses, so this is generous. */
  WEBHOOK_RATE_LIMIT_PER_MINUTE: z.coerce.number().int().positive().default(1200),
  /** Webhook requests with a bad or missing signature per minute from one IP (forgery and probing). */
  WEBHOOK_BAD_SIGNATURE_LIMIT_PER_MINUTE: z.coerce.number().int().positive().default(20),
  /** Events one installation may cause per minute; beyond it deliveries are acknowledged and dropped. */
  WEBHOOK_INSTALLATION_LIMIT_PER_MINUTE: z.coerce.number().int().positive().default(300),
  /** Runs one installation may have waiting in the queue; more are recorded as skipped (`queue_limit`). */
  QUEUE_MAX_QUEUED_PER_INSTALLATION: z.coerce.number().int().positive().default(100),
  /** Runs waiting in the queue across all installations; more are recorded as skipped (`queue_limit`). */
  QUEUE_MAX_QUEUED_GLOBAL: z.coerce.number().int().positive().default(2000),
  /** Audit entries older than this are deleted (the audit log is not covered by `RETENTION_DAYS`). */
  AUDIT_RETENTION_DAYS: z.coerce.number().int().positive().default(365),
  /** Webhook delivery records (idempotency keys) older than this are deleted. GitHub redelivers within days. */
  WEBHOOK_DELIVERY_RETENTION_DAYS: z.coerce.number().int().positive().default(14),
  /** How often each worker reconciles installations with GitHub and clears stale access caches. */
  ACCESS_REFRESH_INTERVAL_MINUTES: z.coerce.number().int().positive().default(60),
} as const;

export const serverEnvSchema = z.object(serverEnvShape);
export type ServerEnv = z.output<typeof serverEnvSchema>;
