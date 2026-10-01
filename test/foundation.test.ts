import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { buildConfigJsonSchema } from "../src/config/jsonSchema";
import { fetchPullRequest, type PullsClient } from "../src/github/client";
import type { Finding, ReviewResult } from "../src/types";
import { findingSchema, reviewResultSchema } from "../src/types/schema";
import { createLogger, formatLine } from "../src/util/logger";

const root = path.join(__dirname, "..");

const finding: Finding = {
  id: "0123456789abcdef",
  agent: "code_review",
  category: "bug",
  severity: "high",
  confidence: 0.9,
  title: "Null dereference",
  filePath: "src/a.ts",
  startLine: 10,
  endLine: 12,
  evidence: "`user.name` read before the null check",
  impact: "Crash on anonymous users",
  recommendation: "Check for null first",
  sourceCommitSha: "abc1234",
};

describe("type validators", () => {
  it("accepts a valid finding and one with only required fields", () => {
    expect(findingSchema.safeParse(finding).success).toBe(true);
    const { filePath, startLine, endLine, ...minimal } = finding;
    expect(findingSchema.safeParse(minimal).success).toBe(true);
  });

  it.each([
    ["bad severity", { severity: "urgent" }],
    ["bad category", { category: "style" }],
    ["bad agent", { agent: "other" }],
    ["confidence above 1", { confidence: 1.2 }],
    ["confidence below 0", { confidence: -0.1 }],
    ["non-integer line", { startLine: 1.5 }],
    ["zero line", { startLine: 0 }],
    ["missing title", { title: undefined }],
    ["unknown field", { extra: true }],
  ])("rejects a finding with %s", (_name, patch) => {
    expect(findingSchema.safeParse({ ...finding, ...patch }).success).toBe(false);
  });

  it("validates a ReviewResult", () => {
    const result: ReviewResult = {
      pullRequestNumber: 7,
      headSha: "abc1234",
      status: "completed",
      findings: [finding],
      coverage: { status: "measured", changedLineCoverage: 0.8, observations: [] },
      skippedFiles: [{ path: "dist/index.js", reason: "ignored" }],
      agentRuns: [{ agent: "code_review", status: "ok", durationMs: 1200 }],
      warnings: [],
    };
    expect(reviewResultSchema.safeParse(result).success).toBe(true);
    expect(reviewResultSchema.safeParse({ ...result, status: "done" }).success).toBe(false);
    expect(
      reviewResultSchema.safeParse({ ...result, findings: [{ ...finding, confidence: 5 }] })
        .success,
    ).toBe(false);
  });
});

describe("config JSON Schema file", () => {
  it("schemas/ai-pr-review.schema.json is up to date (run `npm run schema`)", () => {
    const onDisk = readFileSync(path.join(root, "schemas", "ai-pr-review.schema.json"), "utf8");
    expect(JSON.parse(onDisk)).toEqual(JSON.parse(JSON.stringify(buildConfigJsonSchema())));
  });

  it("requires provider and model, and forbids unknown keys", () => {
    const schema = buildConfigJsonSchema() as {
      required: string[];
      additionalProperties: boolean;
    };
    expect(schema.required).toEqual(expect.arrayContaining(["provider", "model"]));
    expect(schema.additionalProperties).toBe(false);
  });
});

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

describe("fetchPullRequest", () => {
  const client = (data: Awaited<ReturnType<PullsClient["rest"]["pulls"]["get"]>>["data"]) =>
    ({ rest: { pulls: { get: async () => ({ data }) } } }) satisfies PullsClient;

  it("maps API data, including fork detection", async () => {
    const info = await fetchPullRequest(
      client({
        number: 3,
        draft: true,
        base: { ref: "master", repo: { full_name: "a/b" } },
        head: { sha: "deadbeef", repo: { full_name: "c/b" } },
      }),
      { owner: "a", repo: "b" },
      3,
    );
    expect(info).toEqual({
      number: 3,
      baseRef: "master",
      headSha: "deadbeef",
      isDraft: true,
      isFork: true,
    });
  });
});
