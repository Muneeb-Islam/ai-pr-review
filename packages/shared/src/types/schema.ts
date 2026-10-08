import { z } from "zod";
import type {
  AccountType,
  AgentId,
  AgentRunStatus,
  Category,
  FeedbackVerdict,
  Finding,
  InstallationRole,
  InstallationStatus,
  PostedCommentKind,
  ReviewResult,
  ReviewStatus,
  RunStatus,
  RunTrigger,
  Severity,
  SuppressReason,
} from "./index";

export const SEVERITIES = ["critical", "high", "medium", "low", "info"] as const;
export const CATEGORIES = [
  "bug",
  "security",
  "test_gap",
  "performance",
  "maintainability",
] as const;
export const AGENT_IDS = ["code_review", "test_coverage", "security", "final_review"] as const;
export const COVERAGE_STATUSES = ["measured", "not_available", "skipped"] as const;
export const COVERAGE_REASONS = [
  "actions_denied",
  "no_runs",
  "ci_running",
  "no_artifact",
  "artifact_expired",
  "artifact_too_large",
  "artifact_invalid",
  "lcov_missing",
  "lcov_invalid",
  "lcov_empty",
  "github_error",
  "no_client",
  "no_source_files",
] as const;
export const REVIEW_STATUSES = ["completed", "partial", "skipped", "failed"] as const;
export const TRACKED_STATES = ["resolved", "still_applicable", "not_evaluated"] as const;

export const RUN_STATUSES = [
  "queued",
  "running",
  "completed",
  "partial",
  "failed",
  "skipped",
  "superseded",
  "cancelled",
] as const;
export const RUN_TRIGGERS = [
  "pull_request",
  "comment_command",
  "check_run_rerequested",
  "dashboard_rerun",
] as const;
export const AGENT_RUN_STATUSES = ["ok", "failed", "timeout", "invalid_output"] as const;
export const INSTALLATION_STATUSES = ["active", "suspended", "deleted"] as const;
export const ACCOUNT_TYPES = ["user", "organization"] as const;
export const INSTALLATION_ROLES = ["admin", "viewer"] as const;
export const FEEDBACK_VERDICTS = ["useful", "false_positive", "known"] as const;
export const POSTED_COMMENT_KINDS = ["review_comment", "summary", "check"] as const;
export const SUPPRESS_REASONS = [
  "below_threshold",
  "invalid_line",
  "no_evidence",
  "duplicate",
  "style_only",
  "rejected_by_final_review",
] as const;

export const severitySchema: z.ZodType<Severity> = z.enum(SEVERITIES);
export const categorySchema: z.ZodType<Category> = z.enum(CATEGORIES);
export const agentIdSchema: z.ZodType<AgentId> = z.enum(AGENT_IDS);
export const reviewStatusSchema: z.ZodType<ReviewStatus> = z.enum(REVIEW_STATUSES);

export const runStatusSchema: z.ZodType<RunStatus> = z.enum(RUN_STATUSES);
export const runTriggerSchema: z.ZodType<RunTrigger> = z.enum(RUN_TRIGGERS);
export const agentRunStatusSchema: z.ZodType<AgentRunStatus> = z.enum(AGENT_RUN_STATUSES);
export const installationStatusSchema: z.ZodType<InstallationStatus> =
  z.enum(INSTALLATION_STATUSES);
export const accountTypeSchema: z.ZodType<AccountType> = z.enum(ACCOUNT_TYPES);
export const installationRoleSchema: z.ZodType<InstallationRole> = z.enum(INSTALLATION_ROLES);
export const feedbackVerdictSchema: z.ZodType<FeedbackVerdict> = z.enum(FEEDBACK_VERDICTS);
export const postedCommentKindSchema: z.ZodType<PostedCommentKind> = z.enum(POSTED_COMMENT_KINDS);
export const suppressReasonSchema: z.ZodType<SuppressReason> = z.enum(SUPPRESS_REASONS);

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
