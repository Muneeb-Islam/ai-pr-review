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
  it("fails with the NAMES of missing variables only", () => {
    expect(() => loadApiEnv({})).toThrow(
      "Missing required environment variables: DATABASE_URL, GITHUB_APP_ID, GITHUB_APP_PRIVATE_KEY, GITHUB_WEBHOOK_SECRET, REDIS_URL",
    );
  });

  it("loads defaults for the optional ones", () => {
    const env = loadApiEnv({
      DATABASE_URL: "postgres://u:p@localhost:5432/db",
      REDIS_URL: "redis://localhost:6379",
      GITHUB_APP_ID: "1",
      GITHUB_APP_PRIVATE_KEY: "pem",
      GITHUB_WEBHOOK_SECRET: "s",
    });
    expect(env.WEBHOOK_MAX_BODY_BYTES).toBe(5 * 1024 * 1024);
    expect(env.PORT).toBe(3000);
    expect(env.HOST).toBe("127.0.0.1");
  });
});
