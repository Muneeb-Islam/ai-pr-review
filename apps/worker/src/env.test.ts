import { describe, expect, it } from "vitest";
import { loadWorkerEnv } from "./env";

describe("worker env", () => {
  it("fails with the NAME of the missing variable only", () => {
    expect(() => loadWorkerEnv({})).toThrow("Missing required environment variables: REDIS_URL");
  });

  it("loads with just REDIS_URL", () => {
    expect(loadWorkerEnv({ REDIS_URL: "redis://localhost:6379" }).NODE_ENV).toBe("development");
  });
});
