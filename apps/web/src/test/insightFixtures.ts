// Builders for the wire shapes of the history, analytics and settings endpoints (see fixtures.ts for runs and repos).
import type { CallResult } from "@ai-pr-review/shared/api";

export type ExplorerFindingDto = CallResult<"listFindings">["items"][number];
export type SummaryDto = CallResult<"getAnalyticsSummary">;
export type TimeseriesDto = CallResult<"getAnalyticsTimeseries">;
export type RepoSettingsDto = CallResult<"getRepoSettings">;
export type InstallationSettingsDto = CallResult<"getInstallationSettings">;
export type HistoryDto = CallResult<"getPullHistory">;

let counter = 0;
const next = () => ++counter;

export const NO_FEEDBACK = { useful: 0, false_positive: 0, known: 0, mine: null } as const;

export const makeExplorerFinding = (o: Partial<ExplorerFindingDto> = {}): ExplorerFindingDto => {
  const n = next();
  return {
    id: `f-${n}`,
    agent: "code_review",
    category: "bug",
    severity: "high",
    confidence: 0.9,
    title: `Finding number ${n}`,
    file_path: "src/user.ts",
    start_line: 10,
    end_line: 12,
    evidence: "user.name is read before the null check",
    impact: "Throws a TypeError for anonymous users.",
    recommendation: "Check for null first.",
    suggested_test: null,
    posted: true,
    suppressed_reason: null,
    github_url: `https://github.com/acme/api/pull/101#discussion_r${n}`,
    feedback: { ...NO_FEEDBACK },
    run_id: "run-1",
    repo_id: "repo-1",
    repo_full_name: "acme/api",
    pr_number: 101,
    pr_url: "https://github.com/acme/api/pull/101",
    head_sha: "a".repeat(40),
    queued_at: "2026-10-05T09:00:00.000Z",
    ...o,
  };
};

export const makeSummary = (o: Partial<SummaryDto> = {}): SummaryDto => ({
  range: { from: "2026-09-05T00:00:00.000Z", to: "2026-10-05T00:00:00.000Z" },
  repositories: 2,
  reviews: {
    total: 40,
    completed: 30,
    partial: 4,
    failed: 2,
    skipped: 2,
    superseded: 1,
    cancelled: 0,
    in_progress: 1,
  },
  completion: { rate: 34 / 36, sample: 36 },
  duration: { median_ms: 150_000, sample: 34 },
  findings: {
    by_severity: { critical: 1, high: 5, medium: 8, low: 3, info: 0 },
    total: 17,
    posted: 12,
    suppressed: 6,
  },
  feedback: {
    votes: 20,
    useful: 15,
    false_positive: 3,
    known: 2,
    rated_findings: 12,
    actionable_rate: 0.75,
    false_positive_rate: 0.15,
  },
  duplicates: { runs_with_comments: 25, runs_with_duplicates: 0, rate: 0 },
  summary_coverage: { with_summary: 33, eligible: 36, rate: 33 / 36 },
  usage: {
    input_tokens: 1_200_000,
    output_tokens: 90_000,
    estimated_cost_usd: 0.41,
    unpriced_tokens: 0,
  },
  ...o,
});

const point = (
  start: string,
  o: Partial<TimeseriesDto["points"][number]> = {},
): TimeseriesDto["points"][number] => ({
  start,
  reviews: 0,
  completed: 0,
  partial: 0,
  failed: 0,
  findings: { critical: 0, high: 0, medium: 0, low: 0, info: 0 },
  median_duration_ms: null,
  input_tokens: 0,
  output_tokens: 0,
  causes: { timeout: 0, invalid_output: 0, agent_failed: 0, other: 0 },
  ...o,
});

export const makeSeries = (): TimeseriesDto => ({
  range: { from: "2026-10-01T00:00:00.000Z", to: "2026-10-03T12:00:00.000Z" },
  bucket: "day",
  points: [
    point("2026-10-01T00:00:00Z", {
      reviews: 3,
      completed: 2,
      partial: 1,
      median_duration_ms: 90_000,
      input_tokens: 3000,
      output_tokens: 300,
      causes: { timeout: 1, invalid_output: 0, agent_failed: 0, other: 0 },
    }),
    point("2026-10-02T00:00:00Z"),
    point("2026-10-03T00:00:00Z", {
      reviews: 1,
      completed: 1,
      median_duration_ms: 400_000,
      input_tokens: 100,
      output_tokens: 10,
    }),
  ],
});

export const makeSettings = (o: Partial<RepoSettingsDto> = {}): RepoSettingsDto => ({
  repo_id: "repo-1",
  enabled: true,
  config: { provider: "deepseek", model: "m-1", review: { mode: "warn" } },
  inherited: {},
  effective: {
    provider: "deepseek",
    model: "m-1",
    base_url: null,
    limits: {
      concurrency: 3,
      max_requests: 20,
      max_total_tokens: 400_000,
      request_timeout_ms: 120_000,
    },
    review: {
      mode: "warn",
      target_branches: ["main", "master"],
      draft_behavior: "summary_only",
      minimum_severity: "medium",
      minimum_confidence: 0.8,
      max_changed_files: 40,
      max_patch_characters: 120_000,
      max_inline_comments: 20,
    },
    agents: { code_review: true, test_coverage: true, security: true, final_review: false },
    coverage: { artifact_name: "coverage", lcov_path: "lcov.info" },
    fork_prs: "skip",
    ignore: ["dist/**", "coverage/**", "**/*.lock"],
    secret_paths: ["**/.env*"],
    instructions: "",
  },
  repo_file_keys: [],
  repo_file: { path: ".github/ai-pr-review.yml", status: "absent", message: null },
  updated_at: "2026-10-04T10:00:00.000Z",
  updated_by: "u1",
  ...o,
});

export const makeInstallationSettings = (
  o: Partial<InstallationSettingsDto> = {},
): InstallationSettingsDto => ({
  installation_id: "i1",
  account_login: "acme",
  config: {},
  effective: makeSettings().effective,
  quotas: { runs_per_day: 200, tokens_per_day: 2_000_000, read_only: true },
  usage_today: { runs: 50, tokens: 500_000, resets_at: "2026-10-06T00:00:00.000Z" },
  retention: { days: 90, read_only: true },
  updated_at: null,
  updated_by: null,
  ...o,
});
