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
