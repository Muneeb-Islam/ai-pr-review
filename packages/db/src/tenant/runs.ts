import { and, desc, eq, gte, inArray, isNull, lt, lte, or, sql } from "drizzle-orm";
import type { RunStatus, RunTrigger, Severity, TokenUsage } from "@ai-pr-review/shared";
import type { Database } from "../client";
import { IllegalTransitionError, InvalidInputError, NotFoundError } from "../errors";
import { ACTIVE_STATUSES, isTerminalStatus, statusesThatCanReach } from "../lifecycle";
import { afterCursor, clampLimit, toPage, type Page } from "../pagination";
import { findings, repositories, reviewRuns } from "../schema";
import { inInstallations, isUuid, type InstallationIds } from "../scope";
import type { Run, StoredFinding } from "../types";

export interface NewRun {
  repoId: string;
  prNumber: number;
  headSha: string;
  baseSha: string;
  baseRef: string;
  trigger: RunTrigger;
  triggeredBy?: string;
  /** The run this one re-runs (dashboard re-run, AC-21). Must belong to the same installation. */
  parentRunId?: string;
  /**
   * Record the run as `skipped` straight away (a guard stopped it: draft, fork, quota, size...).
   * The reason is shown to users so they can see why a PR was not reviewed (design §7).
   */
  skip?: { reason: string };
  /** Clock override (defaults to now); used by the seed script and tests. */
  at?: Date;
}

/** Creates a run in `queued` (or directly `skipped`). The repository must belong to the installation. */
export async function createRun(db: Database, installationId: string, input: NewRun): Promise<Run> {
  if (!isUuid(installationId) || !isUuid(input.repoId)) throw new NotFoundError("Repository");
  if (!Number.isInteger(input.prNumber) || input.prNumber < 1) {
    throw new InvalidInputError("prNumber must be a positive integer");
  }
  if (input.skip && input.skip.reason.trim() === "") {
    throw new InvalidInputError("A skipped run needs a reason");
  }

  const [repo] = await db
    .select({ id: repositories.id })
    .from(repositories)
    .where(and(eq(repositories.id, input.repoId), eq(repositories.installationId, installationId)));
  if (!repo) throw new NotFoundError("Repository");

  if (input.parentRunId !== undefined) {
    const parent = isUuid(input.parentRunId)
      ? await getRunInInstallation(db, installationId, input.parentRunId)
      : undefined;
    if (!parent) throw new NotFoundError("Parent run");
  }

  const at = input.at ?? new Date();
  const [row] = await db
    .insert(reviewRuns)
    .values({
      installationId,
      repoId: input.repoId,
      prNumber: input.prNumber,
      headSha: input.headSha,
      baseSha: input.baseSha,
      baseRef: input.baseRef,
      trigger: input.trigger,
      triggeredBy: input.triggeredBy ?? null,
      parentRunId: input.parentRunId ?? null,
      queuedAt: at,
      ...(input.skip
        ? { status: "skipped" as const, statusReason: input.skip.reason, finishedAt: at }
        : {}),
    })
    .returning();
  return row!;
}

export interface SupersedingRunResult {
  run: Run;
  /** Older queued/running runs of the same pull request that this run replaced (PL-06). */
  superseded: Run[];
  /** True when an identical active run already existed and no new run was created. */
  duplicate: boolean;
}

/** A decision made inside the run's own transaction (quota, queue depth); `reason` becomes the skipped run's reason. */
export type Admission = { allowed: true } | { allowed: false; reason: string };

/** The run was not created because admission was refused (Phase 15, AC-23). */
export interface RejectedRun {
  rejected: string;
}

/**
 * Creates a `queued` run for a pull request and, in the same transaction, supersedes every other queued or
 * running run of that pull request (PL-06, AC-15). A transaction-scoped advisory lock per pull request makes
 * two webhooks racing on the same PR take turns, so exactly one active run remains.
 *
 * If an active run with the same head SHA and trigger already exists, it is returned untouched and nothing is
 * created (`duplicate: true`): the idempotency that keeps a retried event from queueing the same review twice.
 *
 * With `admit`, a new run is only created when it says so, decided in the same transaction under a lock per
 * installation: a burst of events cannot all pass a limit that each would pass alone (daily quota, queue depth).
 * A refusal returns `{ rejected: reason }` and creates nothing; a duplicate never reaches the decision.
 */
export async function createRunSupersedingOlder(
  db: Database,
  installationId: string,
  input: Omit<NewRun, "skip">,
): Promise<SupersedingRunResult>;
export async function createRunSupersedingOlder(
  db: Database,
  installationId: string,
  input: Omit<NewRun, "skip">,
  admit: (tx: Database) => Promise<Admission>,
): Promise<SupersedingRunResult | RejectedRun>;
export async function createRunSupersedingOlder(
  db: Database,
  installationId: string,
  input: Omit<NewRun, "skip">,
  admit?: (tx: Database) => Promise<Admission>,
): Promise<SupersedingRunResult | RejectedRun> {
  if (!isUuid(installationId) || !isUuid(input.repoId)) throw new NotFoundError("Repository");
  if (!Number.isInteger(input.prNumber) || input.prNumber < 1) {
    throw new InvalidInputError("prNumber must be a positive integer");
  }

  return db.transaction(async (tx) => {
    // A transaction handle exposes the same query API as the pool-backed database.
    const txDb = tx as unknown as Database;
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtextextended(${`${input.repoId}:${input.prNumber}`}, 0))`,
    );

    const active = await txDb
      .select()
      .from(reviewRuns)
      .where(
        and(
          eq(reviewRuns.installationId, installationId),
          eq(reviewRuns.repoId, input.repoId),
          eq(reviewRuns.prNumber, input.prNumber),
          inArray(reviewRuns.status, [...ACTIVE_STATUSES]),
        ),
      )
      .orderBy(desc(reviewRuns.queuedAt), desc(reviewRuns.id));

    const duplicate = active.find(
      (r) => r.headSha === input.headSha && r.trigger === input.trigger,
    );
    if (duplicate) return { run: duplicate, superseded: [], duplicate: true };

    if (admit) {
      await tx.execute(
        sql`select pg_advisory_xact_lock(hashtextextended(${`installation:${installationId}`}, 0))`,
      );
      const decision = await admit(txDb);
      if (!decision.allowed) return { rejected: decision.reason };
    }

    const run = await createRun(txDb, installationId, input);
    const superseded: Run[] = [];
    for (const old of active) {
      try {
        superseded.push(
          await transitionRun(txDb, installationId, old.id, "superseded", {
            reason: `Superseded by run ${run.id}`,
          }),
        );
      } catch (err) {
        // A worker finished it between our read and update: nothing left to supersede.
        if (!(err instanceof IllegalTransitionError)) throw err;
      }
    }
    return { run, superseded, duplicate: false };
  });
}

/** The run whose Check Run has this GitHub id (a "re-run" click on the check). */
export async function getRunByCheckRunId(
  db: Database,
  installationIds: InstallationIds,
  checkRunId: number,
): Promise<Run | undefined> {
  if (!Number.isSafeInteger(checkRunId)) return undefined;
  const [row] = await db
    .select()
    .from(reviewRuns)
    .where(
      and(
        eq(reviewRuns.checkRunId, checkRunId),
        inInstallations(reviewRuns.installationId, installationIds),
      ),
    )
    .orderBy(desc(reviewRuns.queuedAt), desc(reviewRuns.id))
    .limit(1);
  return row;
}

async function getRunInInstallation(
  db: Database,
  installationId: string,
  runId: string,
): Promise<Run | undefined> {
  const [row] = await db
    .select()
    .from(reviewRuns)
    .where(and(eq(reviewRuns.id, runId), eq(reviewRuns.installationId, installationId)));
  return row;
}

export async function getRun(
  db: Database,
  installationIds: InstallationIds,
  runId: string,
): Promise<Run | undefined> {
  if (!isUuid(runId)) return undefined;
  const [row] = await db
    .select()
    .from(reviewRuns)
    .where(
      and(eq(reviewRuns.id, runId), inInstallations(reviewRuns.installationId, installationIds)),
    );
  return row;
}

export interface TransitionOptions {
  /** Required when moving to `skipped`; recommended for `failed`, `superseded` and `cancelled`. */
  reason?: string;
  warnings?: string[];
  usage?: TokenUsage;
  /** Clock override (defaults to now). */
  at?: Date;
}

/**
 * The only way a run's status changes after creation. It enforces scope §5.1 (see `lifecycle.ts`),
 * sets `started_at` when the run starts and `finished_at` when it reaches a terminal status, and does
 * so in a single conditional UPDATE, so two writers racing on the same run cannot both win.
 *
 * Throws `NotFoundError` if the run is not in `installationId`, `IllegalTransitionError` otherwise.
 */
export async function transitionRun(
  db: Database,
  installationId: string,
  runId: string,
  to: RunStatus,
  options: TransitionOptions = {},
): Promise<Run> {
  if (!isUuid(installationId) || !isUuid(runId)) throw new NotFoundError("Run");
  if (to === "skipped" && !options.reason?.trim()) {
    throw new InvalidInputError("A skipped run needs a reason");
  }

  const allowedFrom = statusesThatCanReach(to);
  const at = options.at ?? new Date();

  if (allowedFrom.length > 0) {
    const [row] = await db
      .update(reviewRuns)
      .set({
        status: to,
        ...(options.reason !== undefined ? { statusReason: options.reason } : {}),
        ...(options.warnings !== undefined ? { warnings: options.warnings } : {}),
        ...(options.usage !== undefined ? { usage: options.usage } : {}),
        ...(to === "running" ? { startedAt: at } : {}),
        ...(isTerminalStatus(to) ? { finishedAt: at } : {}),
      })
      .where(
        and(
          eq(reviewRuns.id, runId),
          eq(reviewRuns.installationId, installationId),
          inArray(reviewRuns.status, allowedFrom),
        ),
      )
      .returning();
    if (row) return row;
  }

  // No row updated: either the run is not ours, or its current status cannot move to `to`.
  const current = await getRunInInstallation(db, installationId, runId);
  if (!current) throw new NotFoundError("Run");
  throw new IllegalTransitionError(current.status, to);
}

export interface RunDetailsUpdate {
  checkRunId?: number;
  summaryCommentId?: number;
  warnings?: string[];
  usage?: TokenUsage;
}

/** Updates run metadata that is not part of the lifecycle (GitHub ids, warnings, usage). Never touches status. */
export async function updateRunDetails(
  db: Database,
  installationId: string,
  runId: string,
  update: RunDetailsUpdate,
): Promise<Run> {
  if (!isUuid(installationId) || !isUuid(runId)) throw new NotFoundError("Run");
  const set = {
    ...(update.checkRunId !== undefined ? { checkRunId: update.checkRunId } : {}),
    ...(update.summaryCommentId !== undefined ? { summaryCommentId: update.summaryCommentId } : {}),
    ...(update.warnings !== undefined ? { warnings: update.warnings } : {}),
    ...(update.usage !== undefined ? { usage: update.usage } : {}),
  };
  if (Object.keys(set).length === 0) {
    const current = await getRunInInstallation(db, installationId, runId);
    if (!current) throw new NotFoundError("Run");
    return current;
  }
  const [row] = await db
    .update(reviewRuns)
    .set(set)
    .where(and(eq(reviewRuns.id, runId), eq(reviewRuns.installationId, installationId)))
    .returning();
  if (!row) throw new NotFoundError("Run");
  return row;
}

export interface RunFilters {
  repoId?: string;
  /**
   * Restrict to these repositories (the ones the caller may reach; an installation can hold repositories a
   * member cannot see). Combined with `repoId`, both must match. An empty list matches nothing.
   */
  repoIds?: readonly string[];
  status?: RunStatus | readonly RunStatus[];
  baseRef?: string;
  triggeredBy?: string;
  /** Inclusive bounds on `queued_at`. */
  from?: Date;
  to?: Date;
  /** Only runs with at least one (non-suppressed) finding of this severity. */
  severity?: Severity;
  cursor?: string;
  limit?: number;
}

/** Runs of the caller's installations, newest first, in stable `(queued_at, id)` pages. */
export async function listRuns(
  db: Database,
  installationIds: InstallationIds,
  filters: RunFilters = {},
): Promise<Page<Run>> {
  const limit = clampLimit(filters.limit);
  const statuses =
    filters.status === undefined
      ? undefined
      : ([] as RunStatus[]).concat(filters.status as RunStatus | RunStatus[]);
  if (filters.repoId !== undefined && !isUuid(filters.repoId))
    return { items: [], nextCursor: null };
  if (statuses?.length === 0) return { items: [], nextCursor: null };
  const repoIds = filters.repoIds?.filter(isUuid);
  if (repoIds?.length === 0) return { items: [], nextCursor: null };

  const rows = await db
    .select()
    .from(reviewRuns)
    .where(
      and(
        inInstallations(reviewRuns.installationId, installationIds),
        filters.repoId ? eq(reviewRuns.repoId, filters.repoId) : undefined,
        repoIds ? inArray(reviewRuns.repoId, repoIds) : undefined,
        statuses ? inArray(reviewRuns.status, statuses) : undefined,
        filters.baseRef ? eq(reviewRuns.baseRef, filters.baseRef) : undefined,
        filters.triggeredBy ? eq(reviewRuns.triggeredBy, filters.triggeredBy) : undefined,
        filters.from ? gte(reviewRuns.queuedAt, filters.from) : undefined,
        filters.to ? lte(reviewRuns.queuedAt, filters.to) : undefined,
        filters.severity
          ? sql`exists (select 1 from ${findings}
              where ${findings.runId} = ${reviewRuns.id}
                and ${findings.installationId} = ${reviewRuns.installationId}
                and ${findings.severity} = ${filters.severity}
                and ${findings.suppressedReason} is null)`
          : undefined,
        filters.cursor
          ? afterCursor(reviewRuns.queuedAt, reviewRuns.id, filters.cursor)
          : undefined,
      ),
    )
    .orderBy(desc(reviewRuns.queuedAt), desc(reviewRuns.id))
    .limit(limit + 1);

  return toPage(rows, limit, (r) => ({ at: r.queuedAt, id: r.id }));
}

/** Runs for one pull request (any head SHA unless given), newest first. Used for dedupe and supersede. */
export async function listRunsForPullRequest(
  db: Database,
  installationIds: InstallationIds,
  repoId: string,
  prNumber: number,
  options: { headSha?: string; status?: RunStatus | readonly RunStatus[] } = {},
): Promise<Run[]> {
  if (!isUuid(repoId)) return [];
  const statuses =
    options.status === undefined
      ? undefined
      : ([] as RunStatus[]).concat(options.status as RunStatus | RunStatus[]);
  if (statuses?.length === 0) return [];
  return db
    .select()
    .from(reviewRuns)
    .where(
      and(
        inInstallations(reviewRuns.installationId, installationIds),
        eq(reviewRuns.repoId, repoId),
        eq(reviewRuns.prNumber, prNumber),
        options.headSha ? eq(reviewRuns.headSha, options.headSha) : undefined,
        statuses ? inArray(reviewRuns.status, statuses) : undefined,
      ),
    )
    .orderBy(desc(reviewRuns.queuedAt), desc(reviewRuns.id));
}

/** The most recent run of each repository (repository list "last run" column). */
export async function getLatestRunPerRepo(
  db: Database,
  installationIds: InstallationIds,
  repoIds?: readonly string[],
): Promise<Run[]> {
  const ids = repoIds?.filter(isUuid);
  if (ids?.length === 0) return [];
  return db
    .selectDistinctOn([reviewRuns.repoId])
    .from(reviewRuns)
    .where(
      and(
        inInstallations(reviewRuns.installationId, installationIds),
        ids ? inArray(reviewRuns.repoId, ids) : undefined,
      ),
    )
    .orderBy(reviewRuns.repoId, desc(reviewRuns.queuedAt), desc(reviewRuns.id));
}

/** The last finished review of a pull request before a given run, with the findings it reported. */
export interface PreviousReview {
  run: Run;
  /** Findings the run reported (not the suppressed ones), most severe first. */
  findings: StoredFinding[];
}

/**
 * The review that came before `run` on the same pull request: the newest earlier run that completed or was partial
 * (a failed, skipped, superseded or cancelled run reported nothing to compare with). Its findings are what the new
 * review is compared with (FR-37) and what an inline comment may already exist for (design §12).
 */
export async function getPreviousReview(
  db: Database,
  installationIds: InstallationIds,
  run: Pick<Run, "id" | "repoId" | "prNumber" | "queuedAt">,
): Promise<PreviousReview | undefined> {
  if (!isUuid(run.repoId) || !isUuid(run.id)) return undefined;
  const [previous] = await db
    .select()
    .from(reviewRuns)
    .where(
      and(
        inInstallations(reviewRuns.installationId, installationIds),
        eq(reviewRuns.repoId, run.repoId),
        eq(reviewRuns.prNumber, run.prNumber),
        inArray(reviewRuns.status, ["completed", "partial"]),
        or(
          lt(reviewRuns.queuedAt, run.queuedAt),
          and(eq(reviewRuns.queuedAt, run.queuedAt), lt(reviewRuns.id, run.id)),
        ),
      ),
    )
    .orderBy(desc(reviewRuns.queuedAt), desc(reviewRuns.id))
    .limit(1);
  if (!previous) return undefined;
  const rows = await db
    .select()
    .from(findings)
    .where(
      and(
        eq(findings.runId, previous.id),
        inInstallations(findings.installationId, installationIds),
        isNull(findings.suppressedReason),
      ),
    )
    .orderBy(findings.severity, findings.filePath, findings.startLine, findings.id);
  return { run: previous, findings: rows };
}
