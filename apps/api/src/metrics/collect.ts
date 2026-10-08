// `GET /metrics` (Phase 15, PL-16): what an operator needs to see, in the Prometheus text format. The gauges are read
// from the database, Redis and the queue at scrape time, so they are the same whichever api instance answers and
// are not lost when a process restarts. Nothing here names a tenant's repository, user or content: installation
// numbers appear only as labels of the GitHub rate-limit gauge, and only for the few with the least quota left.
import type { Database, RowSecurityStatus } from "@ai-pr-review/db";
import { getOperationalStats, type OperationalStats } from "@ai-pr-review/db/system";
import type { RateLimitBoard } from "@ai-pr-review/queue";
import { renderMetrics, type ApiMetrics, type MetricFamily } from "./registry";

/** The slice of the BullMQ queue the metrics read. */
export interface QueueStats {
  counts(): Promise<Record<string, number>>;
  deadLetterCount(): Promise<number>;
}

export interface MetricsSources {
  db: Database;
  /** Without Redis the queue and rate-limit gauges are left out and `aipr_dependency_up{dependency="redis"}` is 0. */
  queue?: QueueStats;
  rateLimits?: RateLimitBoard;
  /** Whether the database role is subject to row-level security (see `getRowSecurityStatus`). */
  rowSecurity?: () => Promise<RowSecurityStatus>;
  counters: ApiMetrics;
  /** A running run without a heartbeat for this long counts as stuck (`RUN_STUCK_TIMEOUT_SECONDS`). */
  staleAfterSeconds: number;
  now?: () => Date;
}

/** How many installations the GitHub rate-limit gauge lists (the ones closest to their limit). */
const RATE_LIMIT_INSTALLATIONS = 20;

const gauge = (name: string, help: string, samples: MetricFamily["samples"]): MetricFamily => ({
  name,
  help,
  type: "gauge",
  samples,
});

async function attempt<T>(fn: () => Promise<T>): Promise<T | undefined> {
  try {
    return await fn();
  } catch {
    return undefined;
  }
}

function databaseFamilies(stats: OperationalStats): MetricFamily[] {
  const failedRatio = (() => {
    const f = stats.finished;
    const total = (f.completed ?? 0) + (f.partial ?? 0) + (f.failed ?? 0);
    return total === 0 ? undefined : (f.failed ?? 0) / total;
  })();
  return [
    gauge("aipr_runs_active", "Review runs waiting in the queue or running right now.", [
      { labels: { status: "queued" }, value: stats.active.queued },
      { labels: { status: "running" }, value: stats.active.running },
    ]),
    gauge(
      "aipr_oldest_queued_run_age_seconds",
      "How long the oldest queued run has waited (0 when nothing is queued). A growing value means the queue is stuck.",
      [{ value: stats.oldestQueuedAgeSeconds ?? 0 }],
    ),
    gauge(
      "aipr_runs_stuck",
      "Running runs whose worker has not shown a heartbeat within the stuck timeout.",
      [{ value: stats.stuckRunning }],
    ),
    gauge(
      "aipr_runs_finished_24h",
      "Runs that reached an end in the last 24 hours, by final status.",
      Object.entries(stats.finished).map(([status, value]) => ({ labels: { status }, value })),
    ),
    gauge(
      "aipr_run_failure_ratio_24h",
      "Failed runs over runs that ran to an end (completed, partial, failed) in the last 24 hours.",
      failedRatio === undefined ? [] : [{ value: failedRatio }],
    ),
    gauge(
      "aipr_run_duration_seconds_24h",
      "Start-to-finish time of completed and partial runs in the last 24 hours.",
      stats.durationSeconds.p50 === null
        ? []
        : [
            { labels: { quantile: "0.5" }, value: stats.durationSeconds.p50 },
            { labels: { quantile: "0.95" }, value: stats.durationSeconds.p95 ?? 0 },
          ],
    ),
    gauge(
      "aipr_webhook_deliveries_24h",
      "Webhook deliveries of the last 24 hours: received, failed (ended in an error), unprocessed (never finished, older than 5 minutes).",
      [
        { labels: { state: "received" }, value: stats.webhooks.received },
        { labels: { state: "failed" }, value: stats.webhooks.failed },
        { labels: { state: "unprocessed" }, value: stats.webhooks.unprocessed },
      ],
    ),
    gauge("aipr_installations", "Installations by status.", [
      { labels: { status: "active" }, value: stats.installations.active },
      { labels: { status: "suspended" }, value: stats.installations.suspended },
      { labels: { status: "deleted" }, value: stats.installations.deleted },
    ]),
    gauge(
      "aipr_tokens_24h",
      "Provider tokens reported by runs that finished in the last 24 hours.",
      [
        { labels: { direction: "input" }, value: stats.tokens.input },
        { labels: { direction: "output" }, value: stats.tokens.output },
      ],
    ),
  ];
}

/** The whole exposition. Never throws: a dependency that does not answer becomes `aipr_dependency_up 0`. */
export async function collectMetrics(sources: MetricsSources): Promise<string> {
  const families: MetricFamily[] = [];

  const stats = await attempt(() =>
    getOperationalStats(sources.db, {
      ...(sources.now ? { now: sources.now() } : {}),
      staleAfterSeconds: sources.staleAfterSeconds,
    }),
  );
  if (stats) families.push(...databaseFamilies(stats));

  let redisUp: number | undefined;
  if (sources.queue) {
    const [counts, dead] = await Promise.all([
      attempt(() => sources.queue!.counts()),
      attempt(() => sources.queue!.deadLetterCount()),
    ]);
    redisUp = counts === undefined ? 0 : 1;
    if (counts) {
      families.push(
        gauge(
          "aipr_queue_jobs",
          "Jobs in the review queue by state.",
          Object.entries(counts).map(([state, value]) => ({ labels: { state }, value })),
        ),
      );
    }
    if (dead !== undefined) {
      families.push(
        gauge(
          "aipr_dead_letter_jobs",
          "Jobs that ran out of retries and are kept for an operator to inspect.",
          [{ value: dead }],
        ),
      );
    }
  }

  if (sources.rateLimits) {
    const lowest = await attempt(() => sources.rateLimits!.lowest(RATE_LIMIT_INSTALLATIONS));
    if (lowest === undefined) redisUp = 0;
    else if (lowest.length > 0) {
      const label = (r: (typeof lowest)[number]) => ({ installation: String(r.installationId) });
      families.push(
        gauge(
          "aipr_github_rate_limit_remaining",
          "Requests left in the current GitHub rate-limit window, for the installations closest to the limit.",
          lowest.map((r) => ({ labels: label(r), value: r.remaining })),
        ),
        gauge(
          "aipr_github_rate_limit_ratio_min",
          "The smallest remaining/limit ratio over all installations seen in the last hour (1 = untouched, 0 = exhausted).",
          [{ value: Math.min(...lowest.map((r) => r.remaining / r.limit)) }],
        ),
      );
    }
  }

  families.push(
    gauge("aipr_dependency_up", "Whether a dependency answered while this scrape was collected.", [
      { labels: { dependency: "postgres" }, value: stats ? 1 : 0 },
      ...(redisUp === undefined ? [] : [{ labels: { dependency: "redis" }, value: redisUp }]),
    ]),
  );

  if (sources.rowSecurity) {
    const status = await attempt(sources.rowSecurity);
    if (status) {
      families.push(
        gauge(
          "aipr_row_level_security_enforced",
          "1 when the database role is subject to the tenant row-level-security policies, 0 for a superuser or table owner.",
          [{ value: status.enforced ? 1 : 0 }],
        ),
      );
    }
  }

  families.push(gauge("aipr_up", "The api process is up.", [{ value: 1 }]));
  families.push(...sources.counters.families());
  return renderMetrics(families);
}
