import { describe, expect, it } from "vitest";
import { buildApp } from "./app";
import { loadApiEnv } from "./env";
import type { Check } from "./health";

const ok: Check = async () => {};
const down: Check = async () => {
  throw new Error("connect ECONNREFUSED postgres://user:hunter2@db:5432/x");
};
const hang: Check = () => new Promise(() => {});

describe("api health endpoints", () => {
  it("/healthz returns 200 without touching dependencies", async () => {
    const app = buildApp({ checks: { postgres: down, redis: down } });
    const res = await app.inject({ method: "GET", url: "/healthz" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: "ok" });
  });

  it("/readyz returns 200 when PostgreSQL and Redis are up", async () => {
    const app = buildApp({ checks: { postgres: ok, redis: ok } });
    const res = await app.inject({ method: "GET", url: "/readyz" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: "ready", checks: { postgres: "ok", redis: "ok" } });
  });

  it.each([
    ["redis", { postgres: ok, redis: down }, { postgres: "ok", redis: "fail" }],
    ["postgres", { postgres: down, redis: ok }, { postgres: "fail", redis: "ok" }],
  ])("/readyz returns 503 when %s is down", async (_name, checks, expected) => {
    const app = buildApp({ checks });
    const res = await app.inject({ method: "GET", url: "/readyz" });
    expect(res.statusCode).toBe(503);
    expect(res.json()).toEqual({ status: "unavailable", checks: expected });
  });

  it("never leaks error details or connection strings", async () => {
    const app = buildApp({ checks: { postgres: down, redis: down } });
    const res = await app.inject({ method: "GET", url: "/readyz" });
    expect(res.body).not.toContain("hunter2");
    expect(res.body).not.toContain("ECONNREFUSED");
  });

  it("treats a hanging dependency as down after the timeout", async () => {
    const app = buildApp({ checks: { postgres: ok, redis: hang }, checkTimeoutMs: 20 });
    const res = await app.inject({ method: "GET", url: "/readyz" });
    expect(res.statusCode).toBe(503);
    expect(res.json().checks.redis).toBe("fail");
  });
});

describe("api env", () => {
  const valid = {
    DATABASE_URL: "postgres://u:p@localhost:5432/db",
    REDIS_URL: "redis://localhost:6379",
    GITHUB_APP_ID: "1",
    GITHUB_APP_PRIVATE_KEY: "pem",
    GITHUB_WEBHOOK_SECRET: "s",
    GITHUB_CLIENT_ID: "client",
    GITHUB_CLIENT_SECRET: "client-secret",
    SESSION_SECRET: "x".repeat(32),
    ENCRYPTION_KEY: Buffer.alloc(32, 1).toString("base64"),
  };

  it("fails with the NAMES of missing variables only", () => {
    expect(() => loadApiEnv({})).toThrow(
      "Missing required environment variables: DATABASE_URL, ENCRYPTION_KEY, GITHUB_APP_ID, GITHUB_APP_PRIVATE_KEY, GITHUB_CLIENT_ID, GITHUB_CLIENT_SECRET, GITHUB_WEBHOOK_SECRET, REDIS_URL, SESSION_SECRET",
    );
  });

  it("rejects a weak session secret and a malformed encryption key without echoing them", () => {
    const weak = { ...valid, SESSION_SECRET: "short-secret", ENCRYPTION_KEY: "not-a-key-at-all" };
    let message = "";
    try {
      loadApiEnv(weak);
    } catch (err) {
      message = (err as Error).message;
    }
    expect(message).toBe(
      "Invalid environment variables (values not shown): ENCRYPTION_KEY, SESSION_SECRET",
    );
    expect(message).not.toContain("short-secret");
    expect(message).not.toContain("not-a-key-at-all");
    // 16 bytes are not enough for AES-256.
    expect(() =>
      loadApiEnv({ ...valid, ENCRYPTION_KEY: Buffer.alloc(16, 1).toString("base64") }),
    ).toThrow("ENCRYPTION_KEY");
  });

  it("loads defaults for the optional ones", () => {
    const env = loadApiEnv(valid);
    expect(env.WEBHOOK_MAX_BODY_BYTES).toBe(5 * 1024 * 1024);
    expect(env.PORT).toBe(3000);
    expect(env.HOST).toBe("127.0.0.1");
    expect(env.API_PUBLIC_URL).toBe("http://localhost:3000");
    expect(env.SESSION_IDLE_TIMEOUT_MINUTES).toBe(120);
    expect(env.SESSION_ABSOLUTE_TIMEOUT_HOURS).toBe(168);
    expect(env.ACCESS_CACHE_TTL_SECONDS).toBe(600);
    expect(env.ENCRYPTION_KEY_VERSION).toBe(1);
    expect(env.TRUST_PROXY).toBe(false);
  });

  it("reads TRUST_PROXY as a boolean", () => {
    expect(loadApiEnv({ ...valid, TRUST_PROXY: "true" }).TRUST_PROXY).toBe(true);
    expect(loadApiEnv({ ...valid, TRUST_PROXY: "false" }).TRUST_PROXY).toBe(false);
  });
});
