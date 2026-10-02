import { describe, expect, it } from "vitest";
import { createLogger, formatLine, registerSecret, runLogger } from "./logger";

describe("logger", () => {
  it("emits key=value fields, including base fields, and skips undefined", () => {
    const lines: string[] = [];
    const log = createLogger({ run: "r1" }, (l) => lines.push(l)).child({ pr: 7 });
    log.info("hello", { agent: "security", status: "ok", skip: undefined });
    expect(lines).toEqual(["INFO  hello run=r1 pr=7 agent=security status=ok"]);
  });

  it("quotes and truncates long or spaced values so content cannot flood the log", () => {
    const line = formatLine("info", "m", { reason: "has spaces", big: "x".repeat(500) });
    expect(line).toContain('reason="has spaces"');
    expect(line.length).toBeLessThan(300);
  });

  it("timed logs duration and status for success and failure", async () => {
    const lines: string[] = [];
    let t = 1000;
    const log = createLogger(
      {},
      (l) => lines.push(l),
      () => (t += 50),
    );
    await log.timed("agent", async () => 1, { agent: "code_review" });
    await expect(
      log.timed("agent", async () => Promise.reject(new Error("boom")), { agent: "security" }),
    ).rejects.toThrow("boom");
    expect(lines[0]).toBe("INFO  agent agent=code_review status=ok durationMs=50");
    expect(lines[1]).toBe("ERROR agent agent=security status=failed durationMs=50");
    expect(lines.join("\n")).not.toContain("boom");
  });
});

describe("logger: redaction and run context", () => {
  it("adds runId, repo and prNumber to every line of a run", () => {
    const lines: string[] = [];
    const log = runLogger(
      createLogger({}, (l) => lines.push(l)),
      { runId: "r9", repo: "acme/app", prNumber: 12 },
    );
    log.info("agent started", { agent: "security" });
    expect(lines).toEqual([
      "INFO  agent started runId=r9 repo=acme/app prNumber=12 agent=security",
    ]);
  });

  it("never logs values of sensitive-looking fields", () => {
    const line = formatLine("info", "m", {
      token: "abc",
      apiKey: "abc",
      GITHUB_WEBHOOK_SECRET: "abc",
      authorization: "Bearer abc",
      ok: "visible",
    });
    expect(line).not.toContain("abc");
    expect(line).toContain("ok=visible");
  });

  it("masks registered secret values wherever they appear", () => {
    registerSecret("s3cr3t-value-123");
    const line = formatLine("error", "failed with s3cr3t-value-123", {
      detail: "x s3cr3t-value-123 y",
    });
    expect(line).not.toContain("s3cr3t-value-123");
    expect(line).toContain("[redacted]");
  });

  it("masks token-shaped strings and private key blocks without registration", () => {
    const line = formatLine("info", "m", {
      a: "ghp_abcdefghijklmnopqrstuvwxyz0123456789",
      b: "sk-abcdefghijklmnop1234",
      c: "-----BEGIN RSA PRIVATE KEY-----MIIBOgIBAAJBAK",
    });
    expect(line).not.toMatch(/ghp_|sk-abc|BEGIN RSA/);
  });
});
