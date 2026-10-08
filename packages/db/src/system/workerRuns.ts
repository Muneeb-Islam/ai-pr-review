// WORKER: the run lifecycle as the worker lives it (design §7, Phase 8). Unscoped by installation because the
// job payload is just a run id; every write is conditional on the run's status and on the attempt number the
// worker claimed (a fencing token), so two workers, a retried job and the sweeper cannot corrupt a run.
import { and, eq, inArray, isNotNull, isNull, lt, ne, or, sql } from "drizzle-orm";
import {
  evaluateQuota,
  type CoverageSummary,
  type DailyUsage,
  type FinalReviewSummary,
  type FindingTracking,
  type QuotaDecision,
  type QuotaLimits,
  type RunStatus,
  type TokenUsage,
} from "@ai-pr-review/shared";
import type { Database } from "../client";
import { InvalidInputError } from "../errors";
import { canTransition, isTerminalStatus } from "../lifecycle";
import { agentRuns, findings, reviewRuns, type SkippedFileRecord } from "../schema";
import { isUuid } from "../scope";
import { findingRow } from "../tenant/internal";
import type { NewAgentRun } from "../tenant/agentRuns";
import type { NewFinding } from "../tenant/findings";
import type { Run } from "../types";

/** Keeps `review_runs.skipped_files` small whatever a pull request contains. */
export const MAX_SKIPPED_FILES = 500;

/** The same for `review_runs.coverage`: files listed, ranges per file, and text lengths are bounded. */
export const MAX_COVERAGE_FILES = 100;
const MAX_COVERAGE_RANGES = 25;
const MAX_COVERAGE_NAMES = 10;
const MAX_COVERAGE_NOTES = 10;
const MAX_COVERAGE_TEXT = 400;

/** The same for `review_runs.tracking`: it lists the previous review's findings, which can be many. */
export const MAX_TRACKED_FINDINGS = 100;
const MAX_TRACKED_TEXT = 300;

export function capTracking(tracking: FindingTracking): FindingTracking {
  const text = (value: string): string =>
    value.length > MAX_TRACKED_TEXT ? `${value.slice(0, MAX_TRACKED_TEXT - 1)}…` : value;
  return {
    ...tracking,
    items: tracking.items.slice(0, MAX_TRACKED_FINDINGS).map((item) => ({
      ...item,
      title: text(item.title),
      ...(item.reason !== undefined ? { reason: text(item.reason) } : {}),
    })),
  };
}

export function capCoverage(coverage: CoverageSummary): CoverageSummary {
  const text = (value: string): string =>
    value.length > MAX_COVERAGE_TEXT ? `${value.slice(0, MAX_COVERAGE_TEXT - 1)}…` : value;
  return {
    ...coverage,
    ...(coverage.reason !== undefined ? { reason: text(coverage.reason) } : {}),
    ...(coverage.files !== undefined
      ? {
          files: coverage.files.slice(0, MAX_COVERAGE_FILES).map((file) => ({
            ...file,
            uncovered: file.uncovered.slice(0, MAX_COVERAGE_RANGES),
            ...(file.uncoveredFunctions !== undefined
              ? {
                  uncoveredFunctions: file.uncoveredFunctions
                    .slice(0, MAX_COVERAGE_NAMES)
                    .map(text),
                }
              : {}),
          })),
        }
      : {}),
    observations: coverage.observations.slice(0, MAX_COVERAGE_NOTES).map(text),
  };
}

/**
 * Atomically moves a `queued` run to `running` and returns it, or `undefined` if it is not `queued` any more
 * (superseded, cancelled, already claimed by another worker, finished). `attempts` is incremented and becomes
 * the caller's fencing token: pass `run.attempts` to every later call.
 */
export async function claimRun(
  db: Database,
  runId: string,
  at: Date = new Date(),
): Promise<Run | undefined> {
  if (!isUuid(runId)) return undefined;
  const [row] = await db
    .update(reviewRuns)
    .set({
      status: "running",
      startedAt: at,
      heartbeatAt: at,
      statusReason: null,
      attempts: sql`${reviewRuns.attempts} + 1`,
    })
    .where(and(eq(reviewRuns.id, runId), eq(reviewRuns.status, "queued")))
    .returning();
  return row;
}

/**
 * Proves the worker is alive. False means the run is no longer ours: it was superseded, cancelled or
 * recovered by the sweeper, and the worker must stop.
 */
export async function touchRunHeartbeat(
  db: Database,
  runId: string,
  attempt: number,
  at: Date = new Date(),
): Promise<boolean> {
  if (!isUuid(runId)) return false;
  const rows = await db
    .update(reviewRuns)
    .set({ heartbeatAt: at })
    .where(
      and(
        eq(reviewRuns.id, runId),
        eq(reviewRuns.status, "running"),
        eq(reviewRuns.attempts, attempt),
      ),
    )
    .returning({ id: reviewRuns.id });
  return rows.length > 0;
}

export interface RunResults {
  agentRuns: readonly NewAgentRun[];
  /** Accepted and suppressed findings, as the engine produced them. */
  findings: readonly NewFinding[];
  warnings: readonly string[];
  usage: TokenUsage;
  skippedFiles: readonly SkippedFileRecord[];
  /** The Test Coverage agent's measurement. Absent when the agent did not run; the stored value is kept then. */
  coverage?: CoverageSummary | undefined;
  /** The previous review's findings and what became of them (FR-37). Absent when there was none to compare. */
  tracking?: FindingTracking | undefined;
  /** What the Final Review pass did. Absent when it did not run. */
  finalReview?: FinalReviewSummary | undefined;
}

/**
 * Persists a review's output in one transaction, only while the run is still `running` under `attempt`
 * (checked with a row lock): a superseded or cancelled run keeps no findings. Safe to repeat: agent runs are
 * upserted by (run, agent), findings by (run, agent, fingerprint[, suppressed reason]), and findings that were
 * already posted keep their `posted` flag. Returns false if the run is no longer ours.
 */
export async function saveRunResults(
  db: Database,
  runId: string,
  attempt: number,
  results: RunResults,
): Promise<boolean> {
  if (!isUuid(runId)) return false;
  for (const f of results.findings) {
    if (f.suppressedReason && f.posted) {
      throw new InvalidInputError("A suppressed finding cannot be posted");
    }
  }

  return db.transaction(async (tx) => {
    const [run] = await tx
      .select({
        id: reviewRuns.id,
        installationId: reviewRuns.installationId,
        repoId: reviewRuns.repoId,
      })
      .from(reviewRuns)
      .where(
        and(
          eq(reviewRuns.id, runId),
          eq(reviewRuns.status, "running"),
          eq(reviewRuns.attempts, attempt),
        ),
      )
      .for("update");
    if (!run) return false;

    // Findings of an earlier, interrupted attempt that were never posted are replaced by this attempt's.
    await tx.delete(findings).where(and(eq(findings.runId, runId), eq(findings.posted, false)));

    const agents = new Map<string, NewAgentRun>();
    for (const a of results.agentRuns) agents.set(a.agent, a);
    for (const a of agents.values()) {
      const values = {
        installationId: run.installationId,
        runId,
        agent: a.agent,
        status: a.status,
        startedAt: a.startedAt ?? null,
        durationMs: Math.round(a.durationMs),
        inputTokens: a.inputTokens,
        outputTokens: a.outputTokens,
        retries: a.retries,
        warnings: a.warnings,
      };
      await tx
        .insert(agentRuns)
        .values(values)
        .onConflictDoUpdate({
          target: [agentRuns.runId, agentRuns.agent],
          set: {
            status: values.status,
            startedAt: values.startedAt,
            durationMs: values.durationMs,
            inputTokens: values.inputTokens,
            outputTokens: values.outputTokens,
            retries: values.retries,
            warnings: values.warnings,
          },
        });
    }

    // One row per (agent, fingerprint, reason); a repeat inside the batch would make ON CONFLICT touch a row twice.
    const unique = new Map<string, NewFinding>();
    for (const f of results.findings) {
      const key = `${f.agent}\u0000${f.fingerprint}\u0000${f.suppressedReason ?? ""}`;
      if (!unique.has(key)) unique.set(key, f);
    }
    for (const f of unique.values()) {
      const row = findingRow(run.installationId, runId, run.repoId, f);
      const { posted: _posted, ...refreshed } = row;
      const target = f.suppressedReason
        ? [findings.runId, findings.agent, findings.fingerprint, findings.suppressedReason]
        : [findings.runId, findings.agent, findings.fingerprint];
      await tx
        .insert(findings)
        .values(row)
        .onConflictDoUpdate({
          target,
          targetWhere: f.suppressedReason
            ? isNotNull(findings.suppressedReason)
            : isNull(findings.suppressedReason),
          // `posted` is left alone: a finding that was already published stays published.
          set: refreshed,
        });
    }

    await tx
      .update(reviewRuns)
      .set({
        warnings: [...results.warnings],
        usage: results.usage,
        skippedFiles: results.skippedFiles.slice(0, MAX_SKIPPED_FILES),
        ...(results.coverage !== undefined ? { coverage: capCoverage(results.coverage) } : {}),
        ...(results.tracking !== undefined ? { tracking: capTracking(results.tracking) } : {}),
        ...(results.finalReview !== undefined ? { finalReview: results.finalReview } : {}),
      })
      .where(eq(reviewRuns.id, runId));
    return true;
  });
}

export interface FinishOptions {
  /** Required for `skipped`; recommended for `failed`. */
  reason?: string;
  warnings?: readonly string[];
  usage?: TokenUsage;
  skippedFiles?: readonly SkippedFileRecord[];
  at?: Date;
}

/**
 * Moves a run this worker claimed from `running` to a terminal status. Returns the updated run, or `undefined`
 * if the run is no longer ours (already superseded, cancelled or recovered), in which case nothing changes.
 */
export async function finishClaimedRun(
  db: Database,
  runId: string,
  attempt: number,
  to: RunStatus,
  options: FinishOptions = {},
): Promise<Run | undefined> {
  if (!isUuid(runId)) return undefined;
  if (!isTerminalStatus(to) || !canTransition("running", to)) {
    throw new InvalidInputError(`A claimed run cannot finish as ${to}`);
  }
  if (to === "skipped" && !options.reason?.trim()) {
    throw new InvalidInputError("A skipped run needs a reason");
  }
  const [row] = await db
    .update(reviewRuns)
    .set({
      status: to,
      statusReason: options.reason ?? null,
      finishedAt: options.at ?? new Date(),
      ...(options.warnings !== undefined ? { warnings: [...options.warnings] } : {}),
      ...(options.usage !== undefined ? { usage: options.usage } : {}),
      ...(options.skippedFiles !== undefined
        ? { skippedFiles: options.skippedFiles.slice(0, MAX_SKIPPED_FILES) }
        : {}),
    })
    .where(
      and(
        eq(reviewRuns.id, runId),
        eq(reviewRuns.status, "running"),
        eq(reviewRuns.attempts, attempt),
      ),
    )
    .returning();
  return row;
}

/**
 * The one move back: `running` -> `queued`, for a run whose worker is shutting down or failed for an
 * infrastructure reason. The next claim increments `attempts` again. Returns undefined if the run is no longer
 * ours.
 */
export async function requeueRun(
  db: Database,
  runId: string,
  attempt: number,
  reason: string,
): Promise<Run | undefined> {
  if (!isUuid(runId)) return undefined;
  const [row] = await db
    .update(reviewRuns)
    .set({ status: "queued", startedAt: null, heartbeatAt: null, statusReason: reason })
    .where(
      and(
        eq(reviewRuns.id, runId),
        eq(reviewRuns.status, "running"),
        eq(reviewRuns.attempts, attempt),
      ),
    )
    .returning();
  return row;
}

/** Running runs whose last heartbeat (or start) is older than `staleBefore`: their worker is presumed dead. */
export async function listStaleRunningRuns(
  db: Database,
  staleBefore: Date,
  limit = 100,
): Promise<Run[]> {
  return db
    .select()
    .from(reviewRuns)
    .where(
      and(
        eq(reviewRuns.status, "running"),
        lt(
          sql`coalesce(${reviewRuns.heartbeatAt}, ${reviewRuns.startedAt}, ${reviewRuns.queuedAt})`,
          staleBefore,
        ),
      ),
    )
    .orderBy(reviewRuns.queuedAt)
    .limit(limit);
}

/** Queued runs older than `olderThan`: normally already picked up; if not, their job may have been lost. */
export async function listStaleQueuedRuns(
  db: Database,
  olderThan: Date,
  limit = 200,
): Promise<Run[]> {
  return db
    .select()
    .from(reviewRuns)
    .where(and(eq(reviewRuns.status, "queued"), lt(reviewRuns.queuedAt, olderThan)))
    .orderBy(reviewRuns.queuedAt)
    .limit(limit);
}

export type Recovery = "requeued" | "failed" | "not_stale";

/**
 * Recovers one stuck run (design §7): back to `queued` for another attempt, or `failed` once it has been
 * started `maxAttempts` times. Conditional on the same attempt number and staleness the caller saw, so a
 * worker that woke up in the meantime wins and nothing happens.
 */
export async function recoverStaleRun(
  db: Database,
  run: Pick<Run, "id" | "attempts">,
  staleBefore: Date,
  maxAttempts: number,
  at: Date = new Date(),
): Promise<Recovery> {
  const stale = and(
    eq(reviewRuns.id, run.id),
    eq(reviewRuns.status, "running"),
    eq(reviewRuns.attempts, run.attempts),
    lt(
      sql`coalesce(${reviewRuns.heartbeatAt}, ${reviewRuns.startedAt}, ${reviewRuns.queuedAt})`,
      staleBefore,
    ),
  );
  if (run.attempts >= maxAttempts) {
    const rows = await db
      .update(reviewRuns)
      .set({
        status: "failed",
        finishedAt: at,
        statusReason: `The review stopped responding ${run.attempts} times and was given up on.`,
      })
      .where(stale)
      .returning({ id: reviewRuns.id });
    return rows.length > 0 ? "failed" : "not_stale";
  }
  const rows = await db
    .update(reviewRuns)
    .set({
      status: "queued",
      startedAt: null,
      heartbeatAt: null,
      statusReason: "The worker stopped responding; the review was queued again.",
    })
    .where(stale)
    .returning({ id: reviewRuns.id });
  return rows.length > 0 ? "requeued" : "not_stale";
}

/**
 * What an installation has used since `since` (the start of the UTC day). Counts runs that were queued or
 * started and not stopped by a guard; a run that a guard or a quota turned into `skipped`, and one superseded
 * or cancelled before it started, consumed nothing. `excludeRunId` leaves out the run being decided on.
 */
export async function getDailyUsage(
  db: Database,
  installationId: string,
  since: Date,
  excludeRunId?: string,
): Promise<DailyUsage> {
  if (!isUuid(installationId)) return { runs: 0, tokens: 0 };
  const [row] = await db
    .select({
      runs: sql<number>`count(*)::int`,
      tokens: sql<string>`coalesce(sum(
        coalesce((${reviewRuns.usage}->>'inputTokens')::bigint, 0)
        + coalesce((${reviewRuns.usage}->>'outputTokens')::bigint, 0)), 0)::text`,
    })
    .from(reviewRuns)
    .where(
      and(
        eq(reviewRuns.installationId, installationId),
        sql`${reviewRuns.queuedAt} >= ${since.toISOString()}::timestamptz`,
        ne(reviewRuns.status, "skipped"),
        or(inArray(reviewRuns.status, ["queued", "running"]), isNotNull(reviewRuns.startedAt)),
        excludeRunId && isUuid(excludeRunId) ? ne(reviewRuns.id, excludeRunId) : undefined,
      ),
    );
  return { runs: row?.runs ?? 0, tokens: Number(row?.tokens ?? 0) };
}

/** `evaluateQuota` over the installation's usage today (UTC). Checked at enqueue and again at start. */
export async function checkDailyQuota(
  db: Database,
  installationId: string,
  limits: QuotaLimits,
  options: { since: Date; excludeRunId?: string },
): Promise<QuotaDecision> {
  const usage = await getDailyUsage(db, installationId, options.since, options.excludeRunId);
  return evaluateQuota(usage, limits);
}
