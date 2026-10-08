import type {
  AgentId,
  AgentRunStatus,
  Category,
  Severity,
  SuppressReason,
} from "@ai-pr-review/shared";

/** What became of a review agent in a run: its recorded status, or why it has none. */
export type AgentState = AgentRunStatus | "off" | "not_run" | "not_available";

export const AGENT_LABELS: Readonly<Record<AgentId, string>> = {
  code_review: "Code Review",
  test_coverage: "Test Coverage",
  security: "Security",
  final_review: "Final Review",
};

export const SEVERITY_LABELS: Readonly<Record<Severity, string>> = {
  critical: "Critical",
  high: "High",
  medium: "Medium",
  low: "Low",
  info: "Info",
};

/** Most severe first (FR-20). */
export const SEVERITY_ORDER: readonly Severity[] = ["critical", "high", "medium", "low", "info"];

export const CATEGORY_LABELS: Readonly<Record<Category, string>> = {
  bug: "Bug",
  security: "Security",
  test_gap: "Test gap",
  performance: "Performance",
  maintainability: "Maintainability",
};

export const SUPPRESS_LABELS: Readonly<Record<SuppressReason, string>> = {
  below_threshold: "below the severity or confidence threshold",
  invalid_line: "pointing at a line that is not in the diff",
  no_evidence: "without evidence",
  duplicate: "duplicates",
  style_only: "style-only",
  rejected_by_final_review: "rejected by the final review",
};

export const shortSha = (sha: string): string => sha.slice(0, 7);
