// What the browser tests need to know: where the test stack listens and the secrets it runs with. The stack is
// a real api (real PostgreSQL and Redis from .env) plus the Vite dev server; GitHub is not involved, so the App
// credentials are made-up and the session is created straight in the database.
import { generateKeyPairSync, randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../../..");

// The repository's .env supplies DATABASE_URL and REDIS_URL (the local infrastructure of `npm run db:up`).
if (existsSync(resolve(ROOT, ".env"))) process.loadEnvFile(resolve(ROOT, ".env"));

export const API_PORT = Number(process.env["E2E_API_PORT"] ?? 3100);
export const WEB_PORT = Number(process.env["E2E_WEB_PORT"] ?? 5273);
export const WEB_URL = `http://localhost:${WEB_PORT}`;
export const API_URL = `http://127.0.0.1:${API_PORT}`;

export const SESSION_SECRET = "e2e-session-secret-0123456789abcdef0123";
export const STATE_FILE = resolve(ROOT, "apps/web/e2e/.state/seed.json");
export const AUTH_FILE = resolve(ROOT, "apps/web/e2e/.state/auth.json");
/** A second session, for the test that signs out (which ends its session for good). */
export const SIGNOUT_AUTH_FILE = resolve(ROOT, "apps/web/e2e/.state/auth-signout.json");

/**
 * The browser tests get a database of their own on the same server (created on demand), so they never touch
 * the data of a running dev stack, and a dev worker on the same server cannot pick up the seeded runs.
 * Override with E2E_DATABASE_URL.
 */
export const E2E_DATABASE_NAME = "aipr_e2e";

export function e2eDatabaseUrl(): string {
  const explicit = process.env["E2E_DATABASE_URL"];
  if (explicit) return explicit;
  const url = new URL(requireEnv("DATABASE_URL"));
  url.pathname = `/${E2E_DATABASE_NAME}`;
  return url.toString();
}

export function requireEnv(name: "DATABASE_URL" | "REDIS_URL"): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(
      `${name} is not set. Copy .env.example to .env and run \`npm run db:up\` and \`npm run db:migrate\`.`,
    );
  }
  return value;
}

/** Environment of the api under test. Everything GitHub-related is a placeholder (nothing calls GitHub). */
export function apiEnv(): Record<string, string> {
  const { privateKey } = generateKeyPairSync("rsa", {
    modulusLength: 2048,
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
    publicKeyEncoding: { type: "spki", format: "pem" },
  });
  return {
    NODE_ENV: "development",
    HOST: "127.0.0.1",
    PORT: String(API_PORT),
    PUBLIC_URL: WEB_URL,
    API_PUBLIC_URL: API_URL,
    DATABASE_URL: e2eDatabaseUrl(),
    REDIS_URL: requireEnv("REDIS_URL"),
    GITHUB_APP_ID: "1",
    GITHUB_APP_PRIVATE_KEY: privateKey,
    GITHUB_APP_SLUG: "ai-pr-review-e2e",
    GITHUB_WEBHOOK_SECRET: "e2e-webhook-secret",
    GITHUB_CLIENT_ID: "e2e-client-id",
    GITHUB_CLIENT_SECRET: "e2e-client-secret",
    SESSION_SECRET,
    ENCRYPTION_KEY: randomBytes(32).toString("base64"),
    // The seeded access cache is fresh, but a long run must not make the api ask GitHub.
    ACCESS_CACHE_TTL_SECONDS: "86400",
    RATE_LIMIT_PER_IP_PER_MINUTE: "5000",
    RATE_LIMIT_PER_USER_PER_MINUTE: "5000",
  };
}
