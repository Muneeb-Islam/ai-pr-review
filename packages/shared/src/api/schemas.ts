// Request and response shapes of the REST API (design §8). The api validates against these, the OpenAPI
// document is generated from them, and the web client is typed by them: one definition for all three.
// Timestamps are ISO-8601 strings on the wire.
import { z } from "zod";
import { limitsSchema, PROVIDERS } from "../config/schema";
import {
  ACCOUNT_TYPES,
  AGENT_IDS,
  AGENT_RUN_STATUSES,
  CATEGORIES,
  COVERAGE_REASONS,
  COVERAGE_STATUSES,
  FEEDBACK_VERDICTS,
  INSTALLATION_ROLES,
  RUN_STATUSES,
  RUN_TRIGGERS,
  SEVERITIES,
  SUPPRESS_REASONS,
  TRACKED_STATES,
} from "../types/schema";

export const providerNameSchema = z.enum(PROVIDERS);
export const roleSchema = z.enum(INSTALLATION_ROLES);

/** Opaque identifier from a URL. Malformed ids are "not found", not a validation error (no existence leak). */
export const idParamSchema = z.string().min(1).max(64);

const timestamp = z.iso.datetime({ offset: true });

export const errorResponseSchema = z.object({
  error: z.object({
    code: z.string().describe("Stable machine-readable code, e.g. not_found or validation_error."),
    message: z.string(),
    request_id: z.string().optional(),
    details: z.array(z.string()).optional(),
  }),
});
export type ErrorResponse = z.output<typeof errorResponseSchema>;

export const okResponseSchema = z.object({ ok: z.literal(true) });

// ---------- identity ----------

export const userSchema = z.object({
  id: z.string(),
  login: z.string(),
  avatar_url: z.string().nullable(),
});

export const installationSummarySchema = z.object({
  id: z.string(),
  account_login: z.string(),
  account_type: z.enum(ACCOUNT_TYPES),
  role: roleSchema,
});

export const meResponseSchema = z.object({
  user: userSchema,
  /** Send as the `X-CSRF-Token` header on every POST, PUT, PATCH and DELETE. */
  csrf_token: z.string(),
  installations: z.array(installationSummarySchema),
  /** Where to install the GitHub App (shown when `installations` is empty). */
  install_url: z.string(),
  /** May this user change the platform-wide AI setting (`PLATFORM_ADMINS`)? */
  platform_admin: z.boolean(),
});

// ---------- repositories ----------

export const lastRunSchema = z.object({
  id: z.string(),
  status: z.enum(RUN_STATUSES),
  pr_number: z.number().int(),
  queued_at: timestamp,
  finished_at: timestamp.nullable(),
});

export const repoSchema = z.object({
  id: z.string(),
  installation_id: z.string(),
  full_name: z.string(),
  default_branch: z.string(),
  is_private: z.boolean(),
  enabled: z.boolean(),
  /** The signed-in user's role on this repository. */
  role: roleSchema,
  last_run: lastRunSchema.nullable(),
});

export const listReposQuerySchema = z.object({
  installation_id: idParamSchema.optional(),
  search: z.string().max(100).optional(),
});
export const listReposResponseSchema = z.object({ items: z.array(repoSchema) });

// ---------- settings ----------

/**
 * The dashboard layer of the configuration (design §6): any subset of the config keys, validated against the
 * shared config schema after the patch is applied. `null` resets a key. See `ai-pr-review.schema.json` for the
 * repository-file keys; `provider`, `model`, `base_url` and `limits` are dashboard-only.
 */
export const configPatchSchema = z
  .record(z.string(), z.unknown())
  .describe(
    "Partial configuration. Mappings merge, arrays and scalars replace, null removes a key.",
  );

const effectiveSettingsSchema = z.object({
  provider: providerNameSchema.nullable(),
  model: z.string().nullable(),
  base_url: z.string().nullable(),
  limits: limitsSchema,
  review: z.record(z.string(), z.unknown()),
  agents: z.record(z.string(), z.unknown()),
  coverage: z.record(z.string(), z.unknown()),
  fork_prs: z.enum(["skip", "review"]),
  ignore: z.array(z.string()),
  secret_paths: z.array(z.string()),
  instructions: z.string(),
});
export type EffectiveSettingsDto = z.output<typeof effectiveSettingsSchema>;

export const repoSettingsResponseSchema = z.object({
  repo_id: z.string(),
  enabled: z.boolean(),
  /** What the dashboard stored for this repository (the raw layer, not including defaults). */
  config: z.record(z.string(), z.unknown()),
  /** Installation-wide defaults this repository inherits. */
  inherited: z.record(z.string(), z.unknown()),
  /** The configuration reviews run with, defaults applied. */
  effective: effectiveSettingsSchema,
  /**
   * Settings (dotted paths such as `review.mode`) that `.github/ai-pr-review.yml` sets on the default branch and
   * that therefore win over the dashboard: shown read-only. Empty when the file is absent or unusable.
   */
  repo_file_keys: z.array(z.string()),
  /** What became of the repository file (design §6): applied, absent, invalid or unavailable (GitHub did not answer). */
  repo_file: z.object({
    path: z.string(),
    status: z.enum(["applied", "absent", "invalid", "unavailable"]),
    /** A fixed sentence; never the file's text. */
    message: z.string().nullable(),
  }),
  updated_at: timestamp.nullable(),
  updated_by: z.string().nullable(),
});

export const patchRepoSettingsBodySchema = z.strictObject({
  enabled: z.boolean().optional(),
  config: configPatchSchema.optional(),
});

export const quotasSchema = z.object({
  runs_per_day: z.number().int(),
  tokens_per_day: z.number().int(),
  /** Quotas are fixed by the server for now. */
  read_only: z.literal(true),
});

export const installationSettingsResponseSchema = z.object({
  installation_id: z.string(),
  account_login: z.string(),
  config: z.record(z.string(), z.unknown()),
  effective: effectiveSettingsSchema,
  quotas: quotasSchema,
  /** What the installation has used since 00:00 UTC today, against `quotas` (PL-11). */
  usage_today: z.object({
    runs: z.number().int(),
    tokens: z.number().int(),
    /** When the day's counters start again. */
    resets_at: timestamp,
  }),
  /** How long finished runs are kept (PL-08). Set by the server; the dashboard only shows it. */
  retention: z.object({ days: z.number().int(), read_only: z.literal(true) }),
  updated_at: timestamp.nullable(),
  updated_by: z.string().nullable(),
});

export const patchInstallationSettingsBodySchema = z.strictObject({
  config: configPatchSchema,
});

// ---------- provider credentials (write-only) ----------

export const putCredentialBodySchema = z.strictObject({
  provider: providerNameSchema,
  api_key: z
    .string()
    .min(8, "api_key is too short")
    .max(512, "api_key is too long")
    .regex(/^[\x21-\x7e]+$/, "api_key must not contain spaces or control characters"),
});

/** All the API ever says about a stored key: it exists, for which provider, its last four characters and when. */
export const credentialSchema = z.object({
  id: z.string(),
  provider: providerNameSchema,
  scope: z.enum(["installation", "repository"]),
  last4: z.string(),
  created_at: timestamp,
});

export const credentialResponseSchema = z.object({ credential: credentialSchema });
export const listCredentialsResponseSchema = z.object({ items: z.array(credentialSchema) });
export const deleteCredentialQuerySchema = z.object({ provider: providerNameSchema });

export const testCredentialResponseSchema = z.object({
  ok: z.boolean(),
  /** A fixed, sanitised sentence. Never contains provider output or the key. */
  message: z.string(),
});

// ---------- platform-wide AI setting (keys write-only, as above) ----------

export const platformAiProviderSchema = z.object({
  provider: providerNameSchema,
  /** Null: no key stored. */
  last4: z.string().nullable(),
  key_added_at: timestamp.nullable(),
  model: z.string().nullable(),
});

export const platformAiResponseSchema = z.object({
  /** The provider used by every repository that has not chosen its own. Null: none. */
  active_provider: providerNameSchema.nullable(),
  providers: z.array(platformAiProviderSchema),
});

export const patchPlatformAiBodySchema = z.strictObject({
  active_provider: providerNameSchema.nullable().optional(),
  /** Model per provider; an empty string clears it. */
  models: z.partialRecord(providerNameSchema, z.string().trim().max(200)).optional(),
});

// ---------- runs ----------

const severityEnum = z.enum(SEVERITIES);
const runStatusEnum = z.enum(RUN_STATUSES);

/** Findings of a run by severity (suppressed ones are not counted). */
export const severityCountsSchema = z.object({
  critical: z.number().int(),
  high: z.number().int(),
  medium: z.number().int(),
  low: z.number().int(),
  info: z.number().int(),
});

export const runSummarySchema = z.object({
  id: z.string(),
  repo_id: z.string(),
  repo_full_name: z.string(),
  pr_number: z.number().int(),
  /** GitHub page of the pull request. */
  pr_url: z.string(),
  head_sha: z.string(),
  base_ref: z.string(),
  trigger: z.enum(RUN_TRIGGERS),
  /** GitHub login of the person who caused the run, when known. */
  triggered_by: z.string().nullable(),
  status: runStatusEnum,
  /** Why the run was skipped, failed, superseded or cancelled (a short code or sentence). */
  status_reason: z.string().nullable(),
  queued_at: timestamp,
  started_at: timestamp.nullable(),
  finished_at: timestamp.nullable(),
  /** The run this one re-runs. */
  parent_run_id: z.string().nullable(),
  finding_counts: severityCountsSchema,
});

/** The statuses of a run that are not final yet: the "pending" view of the dashboard. */
export const ACTIVE_RUN_STATUSES = ["queued", "running"] as const;

const statusListSchema = z
  .string()
  .max(200)
  .refine(
    (value) =>
      value.split(",").every((part) => (RUN_STATUSES as readonly string[]).includes(part.trim())),
    "status must be a comma-separated list of run statuses",
  );

export const listRunsQuerySchema = z.object({
  repo_id: idParamSchema.optional(),
  /** One status or a comma-separated list, e.g. `queued,running` for the pending view. */
  status: statusListSchema.optional(),
  /** Base branch of the pull request. */
  branch: z.string().min(1).max(255).optional(),
  /** GitHub login that triggered the run. */
  author: z.string().min(1).max(100).optional(),
  /** Only runs with at least one finding of this severity. */
  severity: severityEnum.optional(),
  /** Inclusive bounds on the time the run was queued. */
  from: timestamp.optional(),
  to: timestamp.optional(),
  cursor: z.string().min(1).max(500).optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
});

export const listRunsResponseSchema = z.object({
  items: z.array(runSummarySchema),
  /** Pass back as `cursor` for the next page; null on the last page. */
  next_cursor: z.string().nullable(),
});

export const agentRunDtoSchema = z.object({
  agent: z.enum(AGENT_IDS),
  status: z.enum(AGENT_RUN_STATUSES),
  started_at: timestamp.nullable(),
  duration_ms: z.number().int(),
  input_tokens: z.number().int(),
  output_tokens: z.number().int(),
  retries: z.number().int(),
  warnings: z.array(z.string()),
});

/** Feedback on one finding: how many people voted each way and what the signed-in user said (FR-30, AC-19). */
export const feedbackSummarySchema = z.object({
  useful: z.number().int(),
  false_positive: z.number().int(),
  known: z.number().int(),
  mine: z.object({ verdict: z.enum(FEEDBACK_VERDICTS), note: z.string().nullable() }).nullable(),
});
export type FeedbackSummaryDto = z.output<typeof feedbackSummarySchema>;

export const findingDtoSchema = z.object({
  id: z.string(),
  agent: z.enum(AGENT_IDS),
  category: z.enum(CATEGORIES),
  severity: severityEnum,
  confidence: z.number(),
  title: z.string(),
  file_path: z.string().nullable(),
  start_line: z.number().int().nullable(),
  end_line: z.number().int().nullable(),
  /** A short quoted excerpt (at most 500 characters), never a diff or a file. */
  evidence: z.string(),
  impact: z.string(),
  recommendation: z.string(),
  suggested_test: z.string().nullable(),
  /** An inline comment for it is on the pull request. */
  posted: z.boolean(),
  /** Why the engine kept it out of the review; null for a finding that was reported. */
  suppressed_reason: z.enum(SUPPRESS_REASONS).nullable(),
  /** The inline comment on GitHub, or the file and line at the reviewed commit; null for a general finding. */
  github_url: z.string().nullable(),
  feedback: feedbackSummarySchema,
});

const lineRangeDtoSchema = z.object({ start: z.number().int(), end: z.number().int() });

export const coverageFileDtoSchema = z.object({
  path: z.string(),
  /** `not_in_report`: the coverage report has no data for the file, so its coverage is unknown. */
  status: z.enum(["measured", "not_in_report"]),
  covered_lines: z.number().int(),
  total_lines: z.number().int(),
  /** Executable changed lines that never ran. */
  uncovered: z.array(lineRangeDtoSchema),
  uncovered_functions: z.array(z.string()),
  covered_branches: z.number().int().nullable(),
  total_branches: z.number().int().nullable(),
});

/** Measured coverage of the changed lines (FR-22). Suggestions from reading the diff are findings, not part of it. */
export const coverageDtoSchema = z.object({
  status: z.enum(COVERAGE_STATUSES),
  /** Why coverage was not measured; null when it was. */
  reason: z.string().nullable(),
  reason_code: z.enum(COVERAGE_REASONS).nullable(),
  /** 0 to 1; null when no executable changed line was found in the report. */
  changed_line_coverage: z.number().nullable(),
  covered_lines: z.number().int().nullable(),
  total_lines: z.number().int().nullable(),
  files: z.array(coverageFileDtoSchema),
  artifact_name: z.string().nullable(),
  /** GitHub Actions run the report came from. */
  artifact_run_id: z.number().int().nullable(),
  observations: z.array(z.string()),
});
export type CoverageDto = z.output<typeof coverageDtoSchema>;

export const trackedFindingDtoSchema = z.object({
  /** `resolved`: evaluated again and gone. `still_applicable`: reported again. `not_evaluated`: this run could not look. */
  state: z.enum(TRACKED_STATES),
  agent: z.enum(AGENT_IDS),
  category: z.enum(CATEGORIES),
  severity: severityEnum,
  title: z.string(),
  file_path: z.string().nullable(),
  start_line: z.number().int().nullable(),
  /** A fixed sentence saying why, when there is one. */
  reason: z.string().nullable(),
});

/** What became of the previous review's findings in this run (FR-37). */
export const trackingDtoSchema = z.object({
  previous_run_id: z.string(),
  previous_head_sha: z.string(),
  items: z.array(trackedFindingDtoSchema),
});
export type TrackingDto = z.output<typeof trackingDtoSchema>;

/** What the optional Final Review pass did: counts only. */
export const finalReviewDtoSchema = z.object({
  status: z.enum(AGENT_RUN_STATUSES),
  reviewed: z.number().int(),
  approved: z.number().int(),
  rejected: z.number().int(),
  unreviewed: z.number().int(),
});
export type FinalReviewDto = z.output<typeof finalReviewDtoSchema>;

export const runDetailSchema = runSummarySchema.extend({
  base_sha: z.string(),
  /** GitHub page of the Check Run; null until one exists. */
  check_run_url: z.string().nullable(),
  warnings: z.array(z.string()),
  usage: z.object({ input_tokens: z.number().int(), output_tokens: z.number().int() }),
  agent_runs: z.array(agentRunDtoSchema),
  /** Most severe first. */
  findings: z.array(findingDtoSchema),
  /** Findings the engine dropped, by reason (below threshold, invalid line, duplicate...). */
  suppressed_counts: z.record(z.string(), z.number().int()),
  /** Files the review did not look at, with the reason. */
  skipped_files: z.array(z.object({ path: z.string(), reason: z.string() })),
  /** The Test Coverage agent's measured result; null when that agent did not run. */
  coverage: coverageDtoSchema.nullable(),
  /** The previous review's findings and what became of them; null when there was nothing to compare with. */
  tracking: trackingDtoSchema.nullable(),
  /** The Final Review pass; null when it did not run. */
  final_review: finalReviewDtoSchema.nullable(),
});

/** A re-run: the new run (or the identical one that was already waiting) and whether it was created now. */
export const rerunResponseSchema = z.object({
  run: runSummarySchema,
  /** False when an identical run for the same commit was already queued or running and was reused. */
  created: z.boolean(),
});

export const cancelResponseSchema = z.object({ run: runSummarySchema });

/**
 * What the live stream (`GET /api/events`) sends as `run.updated`: ids and the new status only. A client
 * refetches the run through the normal, authorised endpoints.
 */
export const runUpdatedEventSchema = z.object({
  run_id: z.string(),
  repo_id: z.string(),
  status: runStatusEnum,
  at: timestamp,
});
export type RunUpdatedEventDto = z.output<typeof runUpdatedEventSchema>;
