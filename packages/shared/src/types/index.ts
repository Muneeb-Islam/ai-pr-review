// Shared types (PRD §12, docs/design.md §4). Runtime validators live in ./schema.ts.

export type Severity = "critical" | "high" | "medium" | "low" | "info";
export type Category = "bug" | "security" | "test_gap" | "performance" | "maintainability";
export type AgentId = "code_review" | "test_coverage" | "security" | "final_review";

export interface Finding {
  id: string; // stable fingerprint (design §9)
  agent: AgentId;
  category: Category;
  severity: Severity;
  confidence: number; // 0.0–1.0
  title: string;
  filePath?: string;
  startLine?: number;
  endLine?: number;
  evidence: string;
  impact: string;
  recommendation: string;
  suggestedTest?: string;
  sourceCommitSha: string;
}

export type ReviewStatus = "completed" | "partial" | "skipped" | "failed";

export interface ReviewResult {
  pullRequestNumber: number;
  headSha: string;
  status: ReviewStatus;
  findings: Finding[];
  coverage: {
    status: "measured" | "not_available" | "skipped";
    changedLineCoverage?: number;
    observations: string[];
  };
  skippedFiles: Array<{ path: string; reason: string }>;
  agentRuns: Array<{ agent: string; status: string; durationMs: number }>;
  warnings: string[]; // non-sensitive, shown in summary and check output
}

export type ProviderName = "anthropic" | "openai" | "deepseek";

// ---------- run lifecycle (docs/scope.md §5.1, docs/design.md §5, §7, §10) ----------

export type RunStatus =
  | "queued"
  | "running"
  | "completed"
  | "partial"
  | "failed"
  | "skipped"
  | "superseded"
  | "cancelled";

/** How a run was started: a webhook event, or one of the re-run paths (scope FR-02). */
export type RunTrigger =
  "pull_request" | "comment_command" | "check_run_rerequested" | "dashboard_rerun";

export type AgentRunStatus = "ok" | "failed" | "timeout" | "invalid_output";

// ---------- persisted platform entities (docs/design.md §5, §10) ----------

export type InstallationStatus = "active" | "suspended" | "deleted";
export type AccountType = "user" | "organization";
/** A user's role on an installation, cached from GitHub (design §9). */
export type InstallationRole = "admin" | "viewer";
export type FeedbackVerdict = "useful" | "false_positive" | "known";
export type PostedCommentKind = "review_comment" | "summary" | "check";
export type SuppressReason =
  | "below_threshold"
  | "invalid_line"
  | "no_evidence"
  | "duplicate"
  | "style_only"
  | "rejected_by_final_review";

export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
}

/** One agent's execution within a run (`agent_runs` table). */
export interface AgentRun {
  agent: AgentId;
  status: AgentRunStatus;
  startedAt?: string; // ISO 8601
  durationMs: number;
  usage: TokenUsage;
  retries: number;
  warnings: string[];
}

/** A review run (`review_runs` table, without joins). Timestamps are ISO 8601 strings. */
export interface ReviewRun {
  id: string;
  repoId: string;
  prNumber: number;
  headSha: string;
  baseSha: string;
  baseRef: string;
  trigger: RunTrigger;
  triggeredBy?: string;
  status: RunStatus;
  statusReason?: string;
  checkRunId?: number;
  summaryCommentId?: number;
  queuedAt: string;
  startedAt?: string;
  finishedAt?: string;
  parentRunId?: string;
  warnings: string[];
  usage: TokenUsage;
}
