// Analytics (UI-07): the PRD section 13 metrics computed from the runs, findings and feedback in the database,
// as aggregate SQL over the indexed run columns (`installation_id`, `repo_id`, `queued_at`). Tenant-scoped: every
// query is limited to the caller's installations and to the repositories the caller may reach.
//
// What each number means (the same wording is on the dashboard and in docs/design.md):
//  - completion: completed or partial, of the runs that ran to an end by themselves (completed, partial, failed).
//    Skipped, superseded and cancelled runs were never meant to produce a review and are left out.
//  - duration: started to finished, median over completed and partial runs.
//  - feedback: votes on findings that have an inline comment. Actionable = useful votes / all votes; false
//    positive = false_positive votes / all votes; "already known" counts as a vote that is neither.
//  - duplicates: a run has a duplicate when it posted an inline comment that an earlier run of the same pull
//    request had already posted for the same commit (same fingerprint and head SHA).
//  - summary coverage: runs that ended with a summary comment, of the runs that ran to an end.
import { sql, type SQL } from "drizzle-orm";
import type { Severity } from "@ai-pr-review/shared";
import type { Database } from "../client";
import { isUuid, type InstallationIds } from "../scope";

export interface AnalyticsScope {
  /** Repositories to cover (the ones the caller may reach and asked about). An empty list matches nothing. */
  repoIds: readonly string[];
  /** Inclusive bounds on the time runs were queued. */
  from: Date;
  to: Date;
}

const uuidList = (ids: readonly string[]): SQL =>
  sql.join(
    ids.filter(isUuid).map((id) => sql`${id}::uuid`),
    sql`, `,
  );

/** The WHERE clause every query shares, over `review_runs r`. */
function runScope(installationIds: InstallationIds, scope: AnalyticsScope): SQL | undefined {
  const installations = installationIds.filter(isUuid);
  const repos = scope.repoIds.filter(isUuid);
  if (installations.length === 0 || repos.length === 0) return undefined;
  return sql`r.installation_id in (${uuidList(installations)})
    and r.repo_id in (${uuidList(repos)})
    and r.queued_at >= ${scope.from.toISOString()}::timestamptz
    and r.queued_at <= ${scope.to.toISOString()}::timestamptz`;
}

type Row = Record<string, unknown>;
const num = (value: unknown): number => (value === null || value === undefined ? 0 : Number(value));
const numOrNull = (value: unknown): number | null =>
  value === null || value === undefined ? null : Number(value);

async function rows(db: Database, query: SQL): Promise<Row[]> {
  const result = await db.execute(query);
  return result.rows as Row[];
}

// ---------- summary ----------

export interface AnalyticsSummary {
  reviews: {
    total: number;
    completed: number;
    partial: number;
    failed: number;
    skipped: number;
    superseded: number;
    cancelled: number;
    in_progress: number;
  };
  duration: { median_ms: number | null; sample: number };
  /** Runs that ran to an end by themselves, and how many of them have a summary comment. */
  summary: { eligible: number; with_summary: number };
  findings: {
    by_severity: Record<Severity, number>;
    total: number;
    posted: number;
    suppressed: number;
  };
  feedback: {
    votes: number;
    useful: number;
    false_positive: number;
    known: number;
    rated_findings: number;
  };
  duplicates: { runs_with_comments: number; runs_with_duplicates: number };
  /** Tokens by repository, so the caller can price each with its provider. */
  usage: Array<{ repoId: string; inputTokens: number; outputTokens: number }>;
}

const emptySeverities = (): Record<Severity, number> => ({
  critical: 0,
  high: 0,
  medium: 0,
  low: 0,
  info: 0,
});

export async function analyticsSummary(
  db: Database,
  installationIds: InstallationIds,
  scope: AnalyticsScope,
): Promise<AnalyticsSummary> {
  const where = runScope(installationIds, scope);
  const out: AnalyticsSummary = {
    reviews: {
      total: 0,
      completed: 0,
      partial: 0,
      failed: 0,
      skipped: 0,
      superseded: 0,
      cancelled: 0,
      in_progress: 0,
    },
    duration: { median_ms: null, sample: 0 },
    summary: { eligible: 0, with_summary: 0 },
    findings: { by_severity: emptySeverities(), total: 0, posted: 0, suppressed: 0 },
    feedback: { votes: 0, useful: 0, false_positive: 0, known: 0, rated_findings: 0 },
    duplicates: { runs_with_comments: 0, runs_with_duplicates: 0 },
    usage: [],
  };
  if (!where) return out;

  const [runs, severities, feedback, duplicates, usage] = await Promise.all([
    rows(
      db,
      sql`select
        count(*)::int as total,
        count(*) filter (where r.status = 'completed')::int as completed,
        count(*) filter (where r.status = 'partial')::int as partial,
        count(*) filter (where r.status = 'failed')::int as failed,
        count(*) filter (where r.status = 'skipped')::int as skipped,
        count(*) filter (where r.status = 'superseded')::int as superseded,
        count(*) filter (where r.status = 'cancelled')::int as cancelled,
        count(*) filter (where r.status in ('queued', 'running'))::int as in_progress,
        count(*) filter (where r.status in ('completed', 'partial')
          and r.started_at is not null and r.finished_at is not null)::int as duration_sample,
        percentile_cont(0.5) within group (
          order by extract(epoch from (r.finished_at - r.started_at)) * 1000
        ) filter (where r.status in ('completed', 'partial')
          and r.started_at is not null and r.finished_at is not null) as median_ms,
        count(*) filter (where r.status in ('completed', 'partial', 'failed'))::int as eligible,
        count(*) filter (where r.status in ('completed', 'partial', 'failed')
          and (r.summary_comment_id is not null or exists (
            select 1 from posted_comments pc
            where pc.run_id = r.id and pc.installation_id = r.installation_id and pc.kind = 'summary'
          )))::int as with_summary
        from review_runs r where ${where}`,
    ),
    rows(
      db,
      sql`select f.severity,
        count(*) filter (where f.suppressed_reason is null)::int as reported,
        count(*) filter (where f.suppressed_reason is null and f.posted)::int as posted,
        count(*) filter (where f.suppressed_reason is not null)::int as suppressed
        from findings f
        join review_runs r on r.id = f.run_id and r.installation_id = f.installation_id
        where ${where} group by f.severity`,
    ),
    rows(
      db,
      sql`select
        count(*)::int as votes,
        count(*) filter (where ff.verdict = 'useful')::int as useful,
        count(*) filter (where ff.verdict = 'false_positive')::int as false_positive,
        count(*) filter (where ff.verdict = 'known')::int as known,
        count(distinct ff.finding_id)::int as rated_findings
        from finding_feedback ff
        join findings f on f.id = ff.finding_id and f.installation_id = ff.installation_id
        join review_runs r on r.id = f.run_id and r.installation_id = f.installation_id
        where f.posted and f.suppressed_reason is null and ${where}`,
    ),
    rows(
      db,
      sql`select
        count(distinct pc.run_id)::int as runs_with_comments,
        count(distinct pc.run_id) filter (where exists (
          select 1 from posted_comments earlier
          join review_runs er on er.id = earlier.run_id and er.installation_id = earlier.installation_id
          where earlier.kind = 'review_comment'
            and earlier.fingerprint = pc.fingerprint and earlier.head_sha = pc.head_sha
            and er.repo_id = r.repo_id and er.pr_number = r.pr_number
            and (er.queued_at, er.id) < (r.queued_at, r.id)
        ))::int as runs_with_duplicates
        from posted_comments pc
        join review_runs r on r.id = pc.run_id and r.installation_id = pc.installation_id
        where pc.kind = 'review_comment' and ${where}`,
    ),
    rows(
      db,
      sql`select r.repo_id,
        coalesce(sum(coalesce((r.usage->>'inputTokens')::bigint, 0)), 0)::text as input_tokens,
        coalesce(sum(coalesce((r.usage->>'outputTokens')::bigint, 0)), 0)::text as output_tokens
        from review_runs r where ${where} group by r.repo_id`,
    ),
  ]);

  const run = runs[0] ?? {};
  out.reviews = {
    total: num(run["total"]),
    completed: num(run["completed"]),
    partial: num(run["partial"]),
    failed: num(run["failed"]),
    skipped: num(run["skipped"]),
    superseded: num(run["superseded"]),
    cancelled: num(run["cancelled"]),
    in_progress: num(run["in_progress"]),
  };
  out.duration = { median_ms: numOrNull(run["median_ms"]), sample: num(run["duration_sample"]) };
  out.summary = { eligible: num(run["eligible"]), with_summary: num(run["with_summary"]) };

  for (const row of severities) {
    const severity = row["severity"] as Severity;
    out.findings.by_severity[severity] = num(row["reported"]);
    out.findings.total += num(row["reported"]);
    out.findings.posted += num(row["posted"]);
    out.findings.suppressed += num(row["suppressed"]);
  }
  const fb = feedback[0] ?? {};
  out.feedback = {
    votes: num(fb["votes"]),
    useful: num(fb["useful"]),
    false_positive: num(fb["false_positive"]),
    known: num(fb["known"]),
    rated_findings: num(fb["rated_findings"]),
  };
  const dup = duplicates[0] ?? {};
  out.duplicates = {
    runs_with_comments: num(dup["runs_with_comments"]),
    runs_with_duplicates: num(dup["runs_with_duplicates"]),
  };
  out.usage = usage.map((row) => ({
    repoId: String(row["repo_id"]),
    inputTokens: num(row["input_tokens"]),
    outputTokens: num(row["output_tokens"]),
  }));
  return out;
}

// ---------- time series ----------

export type Bucket = "day" | "week";

export interface TimeseriesPoint {
  /** Start of the bucket, UTC, `YYYY-MM-DDTHH:MM:SSZ`. */
  start: string;
  /** Runs that ran to an end by themselves (completed, partial, failed). */
  reviews: number;
  completed: number;
  partial: number;
  failed: number;
  findings: Record<Severity, number>;
  median_duration_ms: number | null;
  input_tokens: number;
  output_tokens: number;
  causes: { timeout: number; invalid_output: number; agent_failed: number; other: number };
}

const BUCKET_SQL = `to_char(date_trunc('BUCKET', r.queued_at at time zone 'UTC'), 'YYYY-MM-DD"T"HH24:MI:SS"Z"')`;

/**
 * Per-bucket numbers for the charts. Only buckets with runs are returned (the caller fills the gaps). Buckets
 * are UTC days or ISO weeks (Monday).
 */
export async function analyticsTimeseries(
  db: Database,
  installationIds: InstallationIds,
  scope: AnalyticsScope,
  bucket: Bucket,
): Promise<TimeseriesPoint[]> {
  const where = runScope(installationIds, scope);
  if (!where) return [];
  const bucketSql = sql.raw(BUCKET_SQL.replace("BUCKET", bucket === "week" ? "week" : "day"));

  const [runs, severities, causes] = await Promise.all([
    rows(
      db,
      sql`select ${bucketSql} as start,
        count(*) filter (where r.status in ('completed', 'partial', 'failed'))::int as reviews,
        count(*) filter (where r.status = 'completed')::int as completed,
        count(*) filter (where r.status = 'partial')::int as partial,
        count(*) filter (where r.status = 'failed')::int as failed,
        percentile_cont(0.5) within group (
          order by extract(epoch from (r.finished_at - r.started_at)) * 1000
        ) filter (where r.status in ('completed', 'partial')
          and r.started_at is not null and r.finished_at is not null) as median_ms,
        coalesce(sum(coalesce((r.usage->>'inputTokens')::bigint, 0)), 0)::text as input_tokens,
        coalesce(sum(coalesce((r.usage->>'outputTokens')::bigint, 0)), 0)::text as output_tokens
        from review_runs r where ${where} group by 1 order by 1`,
    ),
    rows(
      db,
      sql`select ${bucketSql} as start, f.severity, count(*)::int as n
        from findings f
        join review_runs r on r.id = f.run_id and r.installation_id = f.installation_id
        where f.suppressed_reason is null and ${where} group by 1, 2`,
    ),
    rows(
      db,
      sql`select ${bucketSql} as start,
        case
          when exists (select 1 from agent_runs ar where ar.run_id = r.id and ar.status = 'timeout') then 'timeout'
          when exists (select 1 from agent_runs ar where ar.run_id = r.id and ar.status = 'invalid_output') then 'invalid_output'
          when exists (select 1 from agent_runs ar where ar.run_id = r.id and ar.status = 'failed') then 'agent_failed'
          else 'other'
        end as cause,
        count(*)::int as n
        from review_runs r
        where r.status in ('partial', 'failed') and ${where} group by 1, 2`,
    ),
  ]);

  const points = new Map<string, TimeseriesPoint>();
  for (const row of runs) {
    const start = String(row["start"]);
    points.set(start, {
      start,
      reviews: num(row["reviews"]),
      completed: num(row["completed"]),
      partial: num(row["partial"]),
      failed: num(row["failed"]),
      findings: emptySeverities(),
      median_duration_ms: numOrNull(row["median_ms"]),
      input_tokens: num(row["input_tokens"]),
      output_tokens: num(row["output_tokens"]),
      causes: { timeout: 0, invalid_output: 0, agent_failed: 0, other: 0 },
    });
  }
  for (const row of severities) {
    const point = points.get(String(row["start"]));
    if (point) point.findings[row["severity"] as Severity] = num(row["n"]);
  }
  for (const row of causes) {
    const point = points.get(String(row["start"]));
    const cause = row["cause"] as keyof TimeseriesPoint["causes"];
    if (point) point.causes[cause] = num(row["n"]);
  }
  return [...points.values()];
}
