// What an operator needs to see (Phase 15, PL-16): the queue, how long runs take and how often they fail, webhook
// health. Aggregates over the platform, never rows of any tenant, so they are safe for `/metrics`. Also the queue
// depth the limits are checked against (PL-05, PL-11). System module: unscoped by design.
import { sql } from "drizzle-orm";
import type { QueueDepth, RunStatus } from "@ai-pr-review/shared";
import type { Database } from "../client";
import { isUuid } from "../scope";

/** How many runs are waiting, for one installation and in total. */
export async function getQueueDepth(db: Database, installationId: string): Promise<QueueDepth> {
  const result = await db.execute<{ installation: number; global: number }>(sql`
    select
      count(*) filter (where installation_id = ${isUuid(installationId) ? installationId : "00000000-0000-0000-0000-000000000000"}::uuid)::int as installation,
      count(*)::int as global
    from review_runs
    where status = 'queued'
  `);
  const row = result.rows[0];
  return { installation: row?.installation ?? 0, global: row?.global ?? 0 };
}

export interface OperationalStats {
  /** Runs waiting and running right now. */
  active: { queued: number; running: number };
  /** Seconds the oldest queued run has waited, or null when nothing is queued. */
  oldestQueuedAgeSeconds: number | null;
  /** Running runs whose worker has not shown a heartbeat for `staleAfterSeconds`: nobody is working on them. */
  stuckRunning: number;
  /** Runs that reached an end in the window, by final status. */
  finished: Partial<Record<RunStatus, number>>;
  /** Start-to-finish time of completed and partial runs in the window, in seconds. */
  durationSeconds: { count: number; p50: number | null; p95: number | null; sum: number };
  /** Webhook deliveries received in the window. `failed` ended in an error; `unprocessed` never finished. */
  webhooks: { received: number; failed: number; unprocessed: number };
  installations: { active: number; suspended: number; deleted: number };
  /** Tokens reported by the runs that finished in the window. */
  tokens: { input: number; output: number };
}

/** The numbers behind `/metrics`. `windowHours` is the look-back for the "finished" figures (default 24). */
export async function getOperationalStats(
  db: Database,
  options: { now?: Date; windowHours?: number; staleAfterSeconds: number },
): Promise<OperationalStats> {
  const now = options.now ?? new Date();
  const since = new Date(now.getTime() - (options.windowHours ?? 24) * 3_600_000);
  const staleBefore = new Date(now.getTime() - options.staleAfterSeconds * 1000);
  const iso = (d: Date) => d.toISOString();

  const [active, finished, duration, webhooks, installationRows] = await Promise.all([
    db.execute<{
      queued: number;
      running: number;
      oldest: number | null;
      stuck: number;
    }>(sql`
      select
        count(*) filter (where status = 'queued')::int as queued,
        count(*) filter (where status = 'running')::int as running,
        extract(epoch from (${iso(now)}::timestamptz - min(queued_at) filter (where status = 'queued')))::float8 as oldest,
        count(*) filter (where status = 'running' and coalesce(heartbeat_at, started_at) < ${iso(staleBefore)}::timestamptz)::int as stuck
      from review_runs
      where status in ('queued', 'running')
    `),
    db.execute<{ status: RunStatus; n: number; input: string; output: string }>(sql`
      select status, count(*)::int as n,
        coalesce(sum((usage->>'inputTokens')::bigint), 0)::text as input,
        coalesce(sum((usage->>'outputTokens')::bigint), 0)::text as output
      from review_runs
      where finished_at >= ${iso(since)}::timestamptz
      group by status
    `),
    db.execute<{ n: number; p50: number | null; p95: number | null; total: number | null }>(sql`
      select count(*)::int as n,
        percentile_cont(0.5) within group (order by d)::float8 as p50,
        percentile_cont(0.95) within group (order by d)::float8 as p95,
        sum(d)::float8 as total
      from (
        select extract(epoch from (finished_at - started_at)) as d
        from review_runs
        where status in ('completed', 'partial') and started_at is not null
          and finished_at >= ${iso(since)}::timestamptz
      ) durations
    `),
    db.execute<{ received: number; failed: number; unprocessed: number }>(sql`
      select count(*)::int as received,
        count(*) filter (where outcome = 'error')::int as failed,
        count(*) filter (where processed_at is null and received_at < ${iso(new Date(now.getTime() - 300_000))}::timestamptz)::int as unprocessed
      from webhook_deliveries
      where received_at >= ${iso(since)}::timestamptz
    `),
    db.execute<{ status: "active" | "suspended" | "deleted"; n: number }>(
      sql`select status, count(*)::int as n from installations group by status`,
    ),
  ]);

  const a = active.rows[0];
  const d = duration.rows[0];
  const w = webhooks.rows[0];
  const byInstallation = Object.fromEntries(installationRows.rows.map((r) => [r.status, r.n]));
  const finishedByStatus: Partial<Record<RunStatus, number>> = {};
  let input = 0;
  let output = 0;
  for (const row of finished.rows) {
    finishedByStatus[row.status] = row.n;
    input += Number(row.input);
    output += Number(row.output);
  }
  return {
    active: { queued: a?.queued ?? 0, running: a?.running ?? 0 },
    oldestQueuedAgeSeconds: a?.oldest ?? null,
    stuckRunning: a?.stuck ?? 0,
    finished: finishedByStatus,
    durationSeconds: {
      count: d?.n ?? 0,
      p50: d?.p50 ?? null,
      p95: d?.p95 ?? null,
      sum: d?.total ?? 0,
    },
    webhooks: {
      received: w?.received ?? 0,
      failed: w?.failed ?? 0,
      unprocessed: w?.unprocessed ?? 0,
    },
    installations: {
      active: byInstallation["active"] ?? 0,
      suspended: byInstallation["suspended"] ?? 0,
      deleted: byInstallation["deleted"] ?? 0,
    },
    tokens: { input, output },
  };
}
