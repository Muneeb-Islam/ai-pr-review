import { describe, expect, it } from "vitest";
import { z } from "zod";
import { EnvError, loadEnv, serverEnvSchema } from "./env";

const valid = {
  DATABASE_URL: "postgres://u:p@localhost:5432/db",
  REDIS_URL: "redis://localhost:6379",
};

describe("loadEnv", () => {
  it("applies defaults and coerces numbers", () => {
    const env = loadEnv(serverEnvSchema, { ...valid, PORT: "4000" });
    expect(env.PORT).toBe(4000);
    expect(env.HOST).toBe("127.0.0.1");
    expect(env.RETENTION_DAYS).toBe(90);
    expect(env.NODE_ENV).toBe("development");
  });

  it("reports only the NAMES of missing variables", () => {
    try {
      loadEnv(serverEnvSchema, {});
      throw new Error("expected EnvError");
    } catch (err) {
      expect(err).toBeInstanceOf(EnvError);
      expect((err as EnvError).missing).toEqual(["DATABASE_URL", "REDIS_URL"]);
      expect((err as Error).message).toBe(
        "Missing required environment variables: DATABASE_URL, REDIS_URL",
      );
    }
  });

  it("treats an empty value as missing", () => {
    expect(() => loadEnv(serverEnvSchema, { ...valid, DATABASE_URL: "" })).toThrow(/DATABASE_URL/);
  });

  it("names invalid variables without echoing their values", () => {
    const secretish = "hunter2-not-a-url";
    try {
      loadEnv(serverEnvSchema, { ...valid, REDIS_URL: secretish, PORT: "99999" });
      throw new Error("expected EnvError");
    } catch (err) {
      const e = err as EnvError;
      expect(e.invalid).toEqual(["PORT", "REDIS_URL"]);
      expect(e.message).not.toContain(secretish);
      expect(e.message).not.toContain("99999");
    }
  });

  it("works with any zod object schema", () => {
    expect(loadEnv(z.object({ A: z.string() }), { A: "x" })).toEqual({ A: "x" });
  });

  it("leaves later-phase variables optional", () => {
    const env = loadEnv(serverEnvSchema, valid);
    expect(env.GITHUB_APP_ID).toBeUndefined();
    expect(env.ENCRYPTION_KEY).toBeUndefined();
  });
});
