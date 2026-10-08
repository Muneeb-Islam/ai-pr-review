// Phase 15 building blocks in the shared package: secrets from files, the fork caps, the queue limits, JSON logs and the
// masking of registered secrets.
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { applyForkLimits, FORK_PR_LIMITS } from "./config/forkLimits";
import { mergeConfig } from "./config/loader";
import { EnvError, loadEnv, serverEnvSchema } from "./env";
import {
  createLogger,
  defaultLogFormat,
  maskRegisteredSecrets,
  registerSecret,
  registerUrlSecret,
} from "./logger";
import { evaluateQueueDepth, QUEUE_LIMIT } from "./quota";

const dir = mkdtempSync(join(tmpdir(), "aipr-env-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const file = (name: string, content: string): string => {
  const path = join(dir, name);
  writeFileSync(path, content);
  return path;
};

const base = {
  DATABASE_URL: "postgres://u:p@localhost:5432/db",
  REDIS_URL: "redis://localhost:6379",
};

describe("secrets from files (NAME_FILE)", () => {
  it("reads a value from the file, without the trailing newline", () => {
    const env = loadEnv(serverEnvSchema, {
      ...base,
      SESSION_SECRET_FILE: file("session", "x".repeat(40) + "\n"),
    });
    expect(env.SESSION_SECRET).toBe("x".repeat(40));
  });

  it("an explicit variable wins over its file", () => {
    const env = loadEnv(serverEnvSchema, {
      ...base,
      SESSION_SECRET: "y".repeat(40),
      SESSION_SECRET_FILE: file("ignored", "z".repeat(40)),
    });
    expect(env.SESSION_SECRET).toBe("y".repeat(40));
  });

  it("works for the connection strings too, so a deployment can keep every secret out of the environment", () => {
    const env = loadEnv(serverEnvSchema, {
      DATABASE_URL_FILE: file("db", "postgres://aipr:pw@db:5432/aipr\n"),
      REDIS_URL_FILE: file("redis", "redis://redis:6379"),
    });
    expect(env.DATABASE_URL).toBe("postgres://aipr:pw@db:5432/aipr");
    expect(env.REDIS_URL).toBe("redis://redis:6379");
  });

  it("an unreadable file is reported by the name of its variable, never its path or the error", () => {
    const missing = join(dir, "does-not-exist-secret-path");
    try {
      loadEnv(serverEnvSchema, { ...base, SESSION_SECRET_FILE: missing });
      throw new Error("expected EnvError");
    } catch (err) {
      expect(err).toBeInstanceOf(EnvError);
      expect((err as EnvError).invalid).toContain("SESSION_SECRET_FILE");
      expect((err as Error).message).not.toContain("does-not-exist-secret-path");
      expect((err as Error).message).not.toContain(dir);
    }
  });

  it("an empty file counts as unset, and a value still goes through its normal validation", () => {
    const env = loadEnv(serverEnvSchema, { ...base, SESSION_SECRET_FILE: file("empty", "\n") });
    expect(env.SESSION_SECRET).toBeUndefined();
    expect(() =>
      loadEnv(serverEnvSchema, { ...base, SESSION_SECRET_FILE: file("short", "too-short") }),
    ).toThrow(/SESSION_SECRET/);
  });

  it("a variable that merely ends in _FILE for something else is left alone", () => {
    const env = loadEnv(serverEnvSchema, { ...base, SOMETHING_ELSE_FILE: "/nope" });
    expect(env.DATABASE_URL).toBe(base.DATABASE_URL);
  });
});

describe("the new tunables have safe defaults", () => {
  it("rate limits, queue limits and retention", () => {
    const env = loadEnv(serverEnvSchema, base);
    expect(env).toMatchObject({
      WEBHOOK_RATE_LIMIT_PER_MINUTE: 1200,
      WEBHOOK_BAD_SIGNATURE_LIMIT_PER_MINUTE: 20,
      WEBHOOK_INSTALLATION_LIMIT_PER_MINUTE: 300,
      QUEUE_MAX_QUEUED_PER_INSTALLATION: 100,
      QUEUE_MAX_QUEUED_GLOBAL: 2000,
      AUDIT_RETENTION_DAYS: 365,
      WEBHOOK_DELIVERY_RETENTION_DAYS: 14,
    });
    expect(env.METRICS_TOKEN).toBeUndefined(); // /metrics does not exist without a token
  });

  it("a metrics token must be long enough to be a secret", () => {
    expect(() => loadEnv(serverEnvSchema, { ...base, METRICS_TOKEN: "short" })).toThrow(
      /METRICS_TOKEN/,
    );
    expect(
      loadEnv(serverEnvSchema, { ...base, METRICS_TOKEN: "x".repeat(16) }).METRICS_TOKEN,
    ).toHaveLength(16);
  });
});

describe("fork limits (AC-23)", () => {
  const config = mergeConfig({ provider: "deepseek", model: "m" });

  it("lowers every limit that is above the cap", () => {
    const capped = applyForkLimits(config);
    expect(capped.review).toMatchObject(FORK_PR_LIMITS.review);
    expect(capped.limits).toMatchObject({
      concurrency: FORK_PR_LIMITS.limits.concurrency,
      max_requests: FORK_PR_LIMITS.limits.max_requests,
      max_total_tokens: FORK_PR_LIMITS.limits.max_total_tokens,
    });
    // Everything else is as configured, including the timeout and the provider.
    expect(capped.limits.request_timeout_ms).toBe(config.limits.request_timeout_ms);
    expect(capped.provider).toBe("deepseek");
  });

  it("never raises a limit that is already stricter", () => {
    const strict = mergeConfig({
      provider: "deepseek",
      model: "m",
      review: { max_changed_files: 3, max_inline_comments: 2 },
      limits: { max_requests: 2, max_total_tokens: 1000 },
    });
    const capped = applyForkLimits(strict);
    expect(capped.review.max_changed_files).toBe(3);
    expect(capped.review.max_inline_comments).toBe(2);
    expect(capped.limits.max_requests).toBe(2);
    expect(capped.limits.max_total_tokens).toBe(1000);
  });

  it("is idempotent and leaves the original untouched", () => {
    const once = applyForkLimits(config);
    expect(applyForkLimits(once)).toEqual(once);
    expect(config.review.max_changed_files).toBe(40);
  });

  it("the caps are well below the defaults (that is their point)", () => {
    expect(FORK_PR_LIMITS.review.max_changed_files).toBeLessThan(config.review.max_changed_files);
    expect(FORK_PR_LIMITS.limits.max_total_tokens).toBeLessThan(config.limits.max_total_tokens);
  });
});

describe("queue depth limits", () => {
  const limits = { perInstallation: 5, global: 50 };

  it("allows a run while both are below their limit", () => {
    expect(evaluateQueueDepth({ installation: 4, global: 49 }, limits)).toEqual({ allowed: true });
  });

  it("stops at the installation limit with a reason that names the cause and what to do", () => {
    const d = evaluateQueueDepth({ installation: 5, global: 6 }, limits);
    expect(d).toMatchObject({ allowed: false });
    expect(d.allowed === false && d.reason).toContain(QUEUE_LIMIT);
    expect(d.allowed === false && d.reason).toContain("5 reviews of this installation");
  });

  it("stops at the global limit, and the installation limit is reported first when both apply", () => {
    expect(evaluateQueueDepth({ installation: 1, global: 50 }, limits)).toMatchObject({
      allowed: false,
      reason: expect.stringContaining("queue is full"),
    });
    expect(evaluateQueueDepth({ installation: 5, global: 50 }, limits)).toMatchObject({
      reason: expect.stringContaining("of this installation"),
    });
  });
});

describe("JSON logs", () => {
  const lines: string[] = [];
  const log = createLogger(
    { app: "api" },
    (l) => lines.push(l),
    () => Date.UTC(2030, 0, 1),
    "json",
  );

  it("is one JSON object per line with time, level, message and the fields", () => {
    lines.length = 0;
    log.child({ run: "r1" }).info("Run queued", { pr: 7, draft: false, repo: "acme/widgets" });
    expect(JSON.parse(lines[0]!)).toEqual({
      time: "2030-01-01T00:00:00.000Z",
      level: "info",
      msg: "Run queued",
      app: "api",
      run: "r1",
      pr: 7,
      draft: false,
      repo: "acme/widgets",
    });
  });

  it("masks sensitive field names, registered secrets and known token shapes, as the text format does", () => {
    lines.length = 0;
    registerSecret("registered-secret-value-123");
    log.warn("Auth with registered-secret-value-123", {
      api_key: "whatever",
      note: "token ghp_" + "a".repeat(36) + " and registered-secret-value-123",
    });
    const text = lines[0]!;
    expect(text).not.toContain("registered-secret-value-123");
    expect(text).not.toContain("ghp_" + "a".repeat(36));
    expect(JSON.parse(text).api_key).toBe("[redacted]");
  });

  it("does not let a field forge the level, the message or the time", () => {
    lines.length = 0;
    log.info("x", { level: "debug", msg: "forged", time: "never" });
    const entry = JSON.parse(lines[0]!);
    expect(entry.level).toBe("info");
    expect(entry.msg).toBe("x");
    expect(entry.time).toBe("2030-01-01T00:00:00.000Z");
  });

  it("chooses the format from LOG_FORMAT, and JSON in production", () => {
    expect(defaultLogFormat({})).toBe("text");
    expect(defaultLogFormat({ NODE_ENV: "production" })).toBe("json");
    expect(defaultLogFormat({ NODE_ENV: "production", LOG_FORMAT: "text" })).toBe("text");
    expect(defaultLogFormat({ LOG_FORMAT: "json" })).toBe("json");
    expect(defaultLogFormat({ LOG_FORMAT: "nonsense" })).toBe("text");
  });
});

describe("masking registered secrets", () => {
  it("masks every occurrence of a registered value, whatever its format", () => {
    registerSecret("an-unusual-format-secret-0001");
    expect(
      maskRegisteredSecrets("a an-unusual-format-secret-0001 b an-unusual-format-secret-0001"),
    ).toBe("a [REDACTED:secret] b [REDACTED:secret]");
  });

  it("registers the password of a connection string as well as the string", () => {
    registerUrlSecret("postgres://aipr:p%40ss-word-9f8e7d@db:5432/aipr");
    expect(maskRegisteredSecrets("password is p@ss-word-9f8e7d ok")).toBe(
      "password is [REDACTED:secret] ok",
    );
    expect(maskRegisteredSecrets("postgres://aipr:p%40ss-word-9f8e7d@db:5432/aipr")).toContain(
      "[REDACTED:secret]",
    );
  });

  it("ignores values too short to be secrets, and registers a value that is not a URL as a whole", () => {
    registerSecret("abc");
    registerUrlSecret("not a url at all but registered whole");
    expect(maskRegisteredSecrets("abc")).toBe("abc");
    expect(maskRegisteredSecrets("not a url at all but registered whole")).toContain(
      "[REDACTED:secret]",
    );
  });
});
