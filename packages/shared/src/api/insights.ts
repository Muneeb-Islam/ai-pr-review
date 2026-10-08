// Request and response shapes of the history, feedback, analytics, audit and export endpoints (UI-05 to UI-08).
// Same rules as schemas.ts: the api validates against these, the OpenAPI document is generated from them and the
// web client is typed by them. Timestamps are ISO-8601 strings on the wire.
import { z } from "zod";
import { AGENT_IDS, CATEGORIES, FEEDBACK_VERDICTS, SEVERITIES } from "../types/schema";
import {
  feedbackSummarySchema,
  findingDtoSchema,
  idParamSchema,
  runSummarySchema,
  severityCountsSchema,
} from "./schemas";

const timestamp = z.iso.datetime({ offset: true });
const severityEnum = z.enum(SEVERITIES);

// ---------- findings explorer, feedback and per-PR history (UI-05) ----------

/** Which findings the explorer lists: `posted` has an inline comment, `summary_only` does not, `suppressed` was dropped. */
export const FINDING_STATUS_FILTERS = ["posted", "summary_only", "suppressed", "all"] as const;

export const listFindingsQuerySchema = z.object({
  repo_id: idParamSchema.optional(),
  /** Only findings of this run. */
  run_id: idParamSchema.optional(),
  severity: severityEnum.optional(),
  category: z.enum(CATEGORIES).optional(),
  agent: z.enum(AGENT_IDS).optional(),
  /** Defaults to `posted` and `summary_only` together: what the review reported. `suppressed` shows what it dropped. */
  status: z.enum(FINDING_STATUS_FILTERS).optional(),
  /** Case-insensitive part of the file path. */
  path: z.string().min(1).max(200).optional(),
  /** Inclusive bounds on the time the run was queued. */
  from: timestamp.optional(),
  to: timestamp.optional(),
  cursor: z.string().min(1).max(500).optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
});

/** A finding with the run and pull request it belongs to. */
export const explorerFindingSchema = findingDtoSchema.extend({
  run_id: z.string(),
  repo_id: z.string(),
  repo_full_name: z.string(),
  pr_number: z.number().int(),
  pr_url: z.string(),
  head_sha: z.string(),
  /** When the run that produced it was queued. */
  queued_at: timestamp,
});
export type ExplorerFindingDto = z.output<typeof explorerFindingSchema>;

export const listFindingsResponseSchema = z.object({
  items: z.array(explorerFindingSchema),
  next_cursor: z.string().nullable(),
});

/** One vote per user per finding: sending it again replaces the verdict and note. */
export const feedbackBodySchema = z.strictObject({
  verdict: z.enum(FEEDBACK_VERDICTS),
  note: z.string().trim().max(1000).optional(),
});
export const feedbackResponseSchema = z.object({ feedback: feedbackSummarySchema });

export const historyParamsSchema = z.object({
  id: idParamSchema,
  number: z.coerce.number().int().positive().max(2_147_483_647),
});

const findingRefSchema = z.object({
  id: z.string(),
  agent: z.enum(AGENT_IDS),
  category: z.enum(CATEGORIES),
  severity: severityEnum,
  title: z.string(),
  file_path: z.string().nullable(),
  start_line: z.number().int().nullable(),
});
export type FindingRefDto = z.output<typeof findingRefSchema>;

/** What changed in the findings of a pull request between one review and the one before it (FR-37). */
export const historyChangesSchema = z.object({
  /** The earlier run these are compared with; null when this is the first review that reported. */
  compared_to: z.string().nullable(),
  new: z.array(findingRefSchema),
  still_applicable: z.array(findingRefSchema),
  /** Reported before and gone now, by a run that looked again. Ids are the earlier run's findings. */
  resolved: z.array(findingRefSchema),
  /** Reported before, and this run could not tell (the agent that found it did not finish, or did not run). */
  not_evaluated: z.array(findingRefSchema),
});
export type HistoryChangesDto = z.output<typeof historyChangesSchema>;

export const pullHistoryResponseSchema = z.object({
  repo_id: z.string(),
  repo_full_name: z.string(),
  pr_number: z.number().int(),
  pr_url: z.string(),
  /** Oldest first, at most the latest 100. */
  runs: z.array(
    z.object({
      run: runSummarySchema,
      /** Null for a run that did not review (queued, running, failed, skipped, superseded, cancelled). */
      changes: historyChangesSchema.nullable(),
    }),
  ),
  /** True when the pull request has more runs than are listed. */
  truncated: z.boolean(),
});
export type PullHistoryDto = z.output<typeof pullHistoryResponseSchema>;

// ---------- analytics (UI-07) ----------

export const analyticsQuerySchema = z.object({
  repo_id: idParamSchema.optional(),
  installation_id: idParamSchema.optional(),
  /** Inclusive bounds on the time runs were queued. Default: the last 30 days. */
  from: timestamp.optional(),
  to: timestamp.optional(),
});

export const timeseriesQuerySchema = analyticsQuerySchema.extend({
  bucket: z.enum(["day", "week"]).optional(),
});

export const analyticsSummarySchema = z.object({
  range: z.object({ from: timestamp, to: timestamp }),
  /** How many repositories the numbers cover. */
  repositories: z.number().int(),
  reviews: z.object({
    total: z.number().int(),
    completed: z.number().int(),
    partial: z.number().int(),
    failed: z.number().int(),
    skipped: z.number().int(),
    superseded: z.number().int(),
    cancelled: z.number().int(),
    in_progress: z.number().int(),
  }),
  /** Completed or partial, of every run that finished by itself (completed, partial or failed). */
  completion: z.object({ rate: z.number().nullable(), sample: z.number().int() }),
  /** From start to finish, of completed and partial runs. */
  duration: z.object({ median_ms: z.number().nullable(), sample: z.number().int() }),
  findings: z.object({
    /** Reported findings (not suppressed) by severity. */
    by_severity: severityCountsSchema,
    total: z.number().int(),
    /** Of those, the ones with an inline comment. */
    posted: z.number().int(),
    suppressed: z.number().int(),
  }),
  /** From the votes on findings that have an inline comment (PRD section 13). */
  feedback: z.object({
    votes: z.number().int(),
    useful: z.number().int(),
    false_positive: z.number().int(),
    known: z.number().int(),
    /** Posted findings with at least one vote. */
    rated_findings: z.number().int(),
    actionable_rate: z.number().nullable(),
    false_positive_rate: z.number().nullable(),
  }),
  /** Reviews that posted a comment this commit already had, of the reviews that posted any. */
  duplicates: z.object({
    runs_with_duplicates: z.number().int(),
    runs_with_comments: z.number().int(),
    rate: z.number().nullable(),
  }),
  /** Reviews that ended with a summary comment, of those that ran to an end (completed, partial or failed). */
  summary_coverage: z.object({
    with_summary: z.number().int(),
    eligible: z.number().int(),
    rate: z.number().nullable(),
  }),
  usage: z.object({
    input_tokens: z.number().int(),
    output_tokens: z.number().int(),
    /** An estimate from list prices of each repository's current provider; null when no provider is set anywhere. */
    estimated_cost_usd: z.number().nullable(),
    /** Tokens of repositories without a provider (not priced). */
    unpriced_tokens: z.number().int(),
  }),
});
export type AnalyticsSummaryDto = z.output<typeof analyticsSummarySchema>;

export const failureCauseCountsSchema = z.object({
  timeout: z.number().int(),
  invalid_output: z.number().int(),
  agent_failed: z.number().int(),
  other: z.number().int(),
});

export const timeseriesPointSchema = z.object({
  /** Start of the bucket (UTC). */
  start: timestamp,
  reviews: z.number().int(),
  completed: z.number().int(),
  partial: z.number().int(),
  failed: z.number().int(),
  findings: severityCountsSchema,
  median_duration_ms: z.number().nullable(),
  input_tokens: z.number().int(),
  output_tokens: z.number().int(),
  /** Partial and failed runs by what went wrong. */
  causes: failureCauseCountsSchema,
});

export const analyticsTimeseriesSchema = z.object({
  range: z.object({ from: timestamp, to: timestamp }),
  /** The bucket actually used: a long range asked in days is answered in weeks. */
  bucket: z.enum(["day", "week"]),
  points: z.array(timeseriesPointSchema),
});
export type AnalyticsTimeseriesDto = z.output<typeof analyticsTimeseriesSchema>;

// ---------- audit view and export (UI-08, PL-08, PL-15) ----------

export const listAuditQuerySchema = z.object({
  /** One action, e.g. `settings.update` or `run.rerun`. */
  action: z.string().min(1).max(100).optional(),
  cursor: z.string().min(1).max(500).optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
});

export const auditEntrySchema = z.object({
  id: z.string(),
  at: timestamp,
  /** GitHub login of the person; null when the account is gone. */
  user_login: z.string().nullable(),
  action: z.string(),
  /** What it touched, e.g. `repo:<id>` or `run:<id>`. */
  target: z.string(),
  /** Names of what changed (setting keys, provider); never a key or a token. */
  metadata: z.record(z.string(), z.unknown()),
});
export const listAuditResponseSchema = z.object({
  items: z.array(auditEntrySchema),
  next_cursor: z.string().nullable(),
});

export const EXPORT_KINDS = ["runs", "findings"] as const;
export const exportQuerySchema = z.object({
  kind: z.enum(EXPORT_KINDS),
  from: timestamp.optional(),
  to: timestamp.optional(),
});
