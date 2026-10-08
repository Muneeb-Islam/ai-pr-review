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

export type CoverageStatus = "measured" | "not_available" | "skipped";

/** Why coverage could not be measured (FR-23). The code is for filtering and tests; users read the sentence. */
export type CoverageReason =
  | "actions_denied"
  | "no_runs"
  | "ci_running"
  | "no_artifact"
  | "artifact_expired"
  | "artifact_too_large"
  | "artifact_invalid"
  | "lcov_missing"
  | "lcov_invalid"
  | "lcov_empty"
  | "github_error"
  | "no_client"
  | "no_source_files";

/** A run of consecutive lines, as new-file line numbers. */
export interface LineRange {
  start: number;
  end: number;
}

/** What the coverage report says about one changed file (FR-22). */
export interface CoverageFile {
  path: string;
  /** `measured`: the report has the file. `not_in_report`: it does not, so nothing is known about its coverage. */
  status: "measured" | "not_in_report";
  /** Changed lines the report counts as executable, and how many of them ran. */
  coveredLines: number;
  totalLines: number;
  /** Executable changed lines that never ran, as ranges. Capped. */
  uncovered: LineRange[];
  /** Functions declared on changed lines that never ran. Capped. */
  uncoveredFunctions?: string[];
  /** Branches on changed lines, when the report has branch data. */
  coveredBranches?: number;
  totalBranches?: number;
}

/**
 * The Test Coverage agent's measured result for a run (FR-22 to FR-25, `review_runs.coverage`). Only data the
 * report holds goes here; suggestions from reading the diff are findings, never part of this record.
 */
export interface CoverageSummary {
  status: CoverageStatus;
  /** One fixed sentence: why coverage was not measured or skipped. Absent when measured. */
  reason?: string;
  reasonCode?: CoverageReason;
  /** Covered share of executable changed lines in matched files, 0 to 1. Absent when no such line exists. */
  changedLineCoverage?: number;
  coveredLines?: number;
  totalLines?: number;
  /** Changed source files with their measured coverage, or marked as missing from the report. */
  files?: CoverageFile[];
  /** Where the report came from. */
  artifact?: { name: string; runId: number };
  observations: string[];
}

// ---------- findings across runs (FR-37, Phase 13) ----------

/**
 * What became of a finding of the previous review of the pull request: `resolved` (the code was evaluated again
 * and the problem is gone), `still_applicable` (reported again) or `not_evaluated` (this run could not look: the
 * file or the agent was not part of it).
 */
export type TrackedState = "resolved" | "still_applicable" | "not_evaluated";

export interface TrackedFinding {
  state: TrackedState;
  fingerprint: string;
  agent: AgentId;
  category: Category;
  severity: Severity;
  title: string;
  filePath?: string;
  startLine?: number;
  /** For `not_evaluated` and `resolved`: one fixed sentence saying why. */
  reason?: string;
}

/**
 * The comparison of a run with the previous review of the same pull request (`review_runs.tracking`). Holds what
 * the earlier run already stored about its own findings (titles, places), never code.
 */
export interface FindingTracking {
  previousRunId: string;
  previousHeadSha: string;
  items: TrackedFinding[];
}

/** What the optional Final Review pass did (`review_runs.final_review`, design §10). Counts only. */
export interface FinalReviewSummary {
  /** `ok`, or how the pass failed: the findings it could not check were kept. */
  status: AgentRunStatus;
  /** Findings it was asked about. */
  reviewed: number;
  approved: number;
  /** Dropped as unsupported by the diff (`rejected_by_final_review`). */
  rejected: number;
  /** Findings past the pass's limit, kept without a second look. */
  unreviewed: number;
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
