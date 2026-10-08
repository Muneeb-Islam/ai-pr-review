// Builders for the API's wire shapes (the dashboard only ever sees these), with sensible defaults.
import type { CallResult } from "@ai-pr-review/shared/api";

export type MeDto = CallResult<"me">;
export type RepoDto = CallResult<"listRepos">["items"][number];
export type RunSummaryDto = CallResult<"listRuns">["items"][number];
export type RunDetailDto = CallResult<"getRun">;

export const API = "http://api.test";

let counter = 0;
const next = () => ++counter;
const iso = (offsetMs = 0) => new Date(Date.UTC(2026, 9, 5, 10, 0, 0) + offsetMs).toISOString();

export const makeMe = (overrides: Partial<MeDto> = {}): MeDto => ({
  user: { id: "u1", login: "octocat", avatar_url: null },
  csrf_token: "csrf-1",
  installations: [{ id: "i1", account_login: "acme", account_type: "organization", role: "admin" }],
  install_url: "https://github.com/apps/ai-pr-review/installations/new",
  platform_admin: false,
  ...overrides,
});

export const makeRepo = (overrides: Partial<RepoDto> = {}): RepoDto => {
  const n = next();
  return {
    id: `repo-${n}`,
    installation_id: "i1",
    full_name: `acme/repo-${n}`,
    default_branch: "main",
    is_private: true,
    enabled: true,
    role: "admin",
    last_run: null,
    ...overrides,
  };
};

const NO_FINDINGS = { critical: 0, high: 0, medium: 0, low: 0, info: 0 };

export const makeRun = (overrides: Partial<RunSummaryDto> = {}): RunSummaryDto => {
  const n = next();
  return {
    id: `run-${n}`,
    repo_id: "repo-1",
    repo_full_name: "acme/api",
    pr_number: 100 + n,
    pr_url: `https://github.com/acme/api/pull/${100 + n}`,
    head_sha: "a".repeat(40),
    base_ref: "main",
    trigger: "pull_request",
    triggered_by: "octocat",
    status: "completed",
    status_reason: null,
    queued_at: iso(-60_000),
    started_at: iso(-50_000),
    finished_at: iso(-10_000),
    parent_run_id: null,
    finding_counts: { ...NO_FINDINGS },
    ...overrides,
  };
};

export const makeDetail = (overrides: Partial<RunDetailDto> = {}): RunDetailDto => ({
  ...makeRun(),
  base_sha: "b".repeat(40),
  check_run_url: "https://github.com/acme/api/runs/4711",
  warnings: [],
  usage: { input_tokens: 12_000, output_tokens: 900 },
  agent_runs: [
    {
      agent: "code_review",
      status: "ok",
      started_at: iso(-48_000),
      duration_ms: 31_000,
      input_tokens: 12_000,
      output_tokens: 900,
      retries: 0,
      warnings: [],
    },
  ],
  findings: [],
  suppressed_counts: {},
  skipped_files: [],
  coverage: null,
  tracking: null,
  final_review: null,
  ...overrides,
});

export const makeFinding = (
  overrides: Partial<RunDetailDto["findings"][number]> = {},
): RunDetailDto["findings"][number] => ({
  id: `finding-${next()}`,
  agent: "code_review",
  category: "bug",
  severity: "high",
  confidence: 0.9,
  title: "Null dereference on anonymous users",
  file_path: "src/user.ts",
  start_line: 10,
  end_line: 12,
  evidence: "user.name is read before the null check",
  impact: "Throws a TypeError for anonymous users.",
  recommendation: "Check for null first.",
  suggested_test: null,
  posted: true,
  suppressed_reason: null,
  github_url: "https://github.com/acme/api/pull/101#discussion_r1",
  feedback: { useful: 0, false_positive: 0, known: 0, mine: null },
  ...overrides,
});
