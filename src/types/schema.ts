import { z } from "zod";
import type { AgentId, Category, Finding, ReviewResult, ReviewStatus, Severity } from "./index";

export const SEVERITIES = ["critical", "high", "medium", "low", "info"] as const;
export const CATEGORIES = [
  "bug",
  "security",
  "test_gap",
  "performance",
  "maintainability",
] as const;
export const AGENT_IDS = ["code_review", "test_coverage", "security", "final_review"] as const;
export const REVIEW_STATUSES = ["completed", "partial", "skipped", "failed"] as const;

export const severitySchema: z.ZodType<Severity> = z.enum(SEVERITIES);
export const categorySchema: z.ZodType<Category> = z.enum(CATEGORIES);
export const agentIdSchema: z.ZodType<AgentId> = z.enum(AGENT_IDS);
export const reviewStatusSchema: z.ZodType<ReviewStatus> = z.enum(REVIEW_STATUSES);

const line = z.number().int().positive();

// Annotated with the hand-written interfaces so the two cannot drift apart.
export const findingSchema: z.ZodType<Finding> = z.strictObject({
  id: z.string().min(1),
  agent: agentIdSchema,
  category: categorySchema,
  severity: severitySchema,
  confidence: z.number().min(0).max(1),
  title: z.string().min(1),
  filePath: z.string().min(1).optional(),
  startLine: line.optional(),
  endLine: line.optional(),
  evidence: z.string(),
  impact: z.string(),
  recommendation: z.string(),
  suggestedTest: z.string().optional(),
  sourceCommitSha: z.string().min(1),
});

export const reviewResultSchema: z.ZodType<ReviewResult> = z.strictObject({
  pullRequestNumber: z.number().int().positive(),
  headSha: z.string().min(1),
  status: reviewStatusSchema,
  findings: z.array(findingSchema),
  coverage: z.strictObject({
    status: z.enum(["measured", "not_available", "skipped"]),
    changedLineCoverage: z.number().min(0).max(1).optional(),
    observations: z.array(z.string()),
  }),
  skippedFiles: z.array(z.strictObject({ path: z.string(), reason: z.string() })),
  agentRuns: z.array(
    z.strictObject({ agent: z.string(), status: z.string(), durationMs: z.number().nonnegative() }),
  ),
  warnings: z.array(z.string()),
});
