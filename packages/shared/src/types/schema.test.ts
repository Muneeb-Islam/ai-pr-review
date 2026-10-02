import { describe, expect, it } from "vitest";
import type { Finding, ReviewResult } from "./index";
import {
  agentRunStatusSchema,
  findingSchema,
  reviewResultSchema,
  runStatusSchema,
  runTriggerSchema,
} from "./schema";

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

describe("run lifecycle schemas", () => {
  it("accepts every RunStatus from the lifecycle and rejects others", () => {
    for (const s of [
      "queued",
      "running",
      "completed",
      "partial",
      "failed",
      "skipped",
      "superseded",
      "cancelled",
    ]) {
      expect(runStatusSchema.safeParse(s).success).toBe(true);
    }
    expect(runStatusSchema.safeParse("pending").success).toBe(false);
  });

  it("validates triggers and agent run statuses", () => {
    expect(runTriggerSchema.safeParse("dashboard_rerun").success).toBe(true);
    expect(runTriggerSchema.safeParse("workflow_dispatch").success).toBe(false);
    expect(agentRunStatusSchema.safeParse("invalid_output").success).toBe(true);
    expect(agentRunStatusSchema.safeParse("done").success).toBe(false);
  });
});
