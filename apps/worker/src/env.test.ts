import { describe, expect, it } from "vitest";
import { loadWorkerEnv } from "./env";

const KEY = Buffer.alloc(32, 7).toString("base64");
const valid = {
  DATABASE_URL: "postgres://aipr:aipr@localhost:5432/aipr",
  REDIS_URL: "redis://localhost:6379",
  GITHUB_APP_ID: "123",
  GITHUB_APP_PRIVATE_KEY: "pem",
  ENCRYPTION_KEY: KEY,
};

describe("worker env", () => {
  it("fails with the NAMES of the missing variables only", () => {
    expect(() => loadWorkerEnv({})).toThrow(
      "Missing required environment variables: DATABASE_URL, ENCRYPTION_KEY, GITHUB_APP_ID, GITHUB_APP_PRIVATE_KEY, REDIS_URL",
    );
  });

  it("never echoes a value, even an invalid one", () => {
    expect(() => loadWorkerEnv({ ...valid, ENCRYPTION_KEY: "short-secret-value" })).toThrow(
      /Invalid environment variables \(values not shown\): ENCRYPTION_KEY$/,
    );
  });

  it("loads with the defaults of the tunables", () => {
    const env = loadWorkerEnv(valid);
    expect(env).toMatchObject({
      NODE_ENV: "development",
      WORKER_CONCURRENCY: 4,
      WORKER_INSTALLATION_CONCURRENCY: 2,
      RUN_HEARTBEAT_INTERVAL_SECONDS: 10,
      RUN_STUCK_TIMEOUT_SECONDS: 120,
      QUOTA_RUNS_PER_DAY: 200,
      QUOTA_TOKENS_PER_DAY: 2_000_000,
    });
  });

  it("reads the tunables from the environment", () => {
    const env = loadWorkerEnv({ ...valid, WORKER_CONCURRENCY: "8", JOB_MAX_ATTEMPTS: "2" });
    expect(env.WORKER_CONCURRENCY).toBe(8);
    expect(env.JOB_MAX_ATTEMPTS).toBe(2);
  });
});
