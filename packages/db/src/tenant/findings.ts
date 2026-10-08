import { and, asc, desc, eq, inArray, isNotNull, isNull, or, sql } from "drizzle-orm";
import type { Finding, Severity, SuppressReason, AgentId, Category } from "@ai-pr-review/shared";
import type { Database } from "../client";
import { InvalidInputError } from "../errors";
import { afterCursor, clampLimit, toPage, type Page } from "../pagination";
import { findings, reviewRuns } from "../schema";
import { inInstallations, isUuid, type InstallationIds } from "../scope";
import type { StoredFinding } from "../types";
import { findingRow, requireRun } from "./internal";

/** A finding as produced by the engine (`Finding` in packages/shared) plus how it was handled. */
export type NewFinding = Omit<Finding, "id" | "sourceCommitSha"> & {
  /** design §12 fingerprint (`Finding.id`). */
  fingerprint: string;
  posted?: boolean;
  suppressedReason?: SuppressReason;
};

/** Stores the findings of a run (accepted and suppressed ones) in one statement. */
export async function insertFindings(
  db: Database,
  installationId: string,
  runId: string,
  input: readonly NewFinding[],
): Promise<StoredFinding[]> {
  const run = await requireRun(db, installationId, runId);
  if (input.length === 0) return [];
  for (const f of input) {
    if (f.suppressedReason && f.posted) {
      throw new InvalidInputError("A suppressed finding cannot be posted");
    }
  }
  return db
    .insert(findings)
    .values(input.map((f) => findingRow(installationId, runId, run.repoId, f)))
    .returning();
}

export async function getFinding(
  db: Database,
  installationIds: InstallationIds,
  findingId: string,
): Promise<StoredFinding | undefined> {
  if (!isUuid(findingId)) return undefined;
  const [row] = await db
    .select()
    .from(findings)
    .where(
      and(eq(findings.id, findingId), inInstallations(findings.installationId, installationIds)),
    );
  return row;
}

/** Findings of one run, most severe first. Suppressed findings are excluded unless asked for. */
export async function listFindingsForRun(
  db: Database,
  installationIds: InstallationIds,
  runId: string,
  options: { includeSuppressed?: boolean } = {},
): Promise<StoredFinding[]> {
  if (!isUuid(runId)) return [];
  return (
    db
      .select()
      .from(findings)
      .where(
        and(
          eq(findings.runId, runId),
          inInstallations(findings.installationId, installationIds),
          options.includeSuppressed ? undefined : isNull(findings.suppressedReason),
        ),
      )
      // Enum order is critical, high, medium, low, info.
      .orderBy(
        asc(findings.severity),
        asc(findings.filePath),
        asc(findings.startLine),
        asc(findings.id),
      )
  );
}

export interface FindingFilters {
  repoId?: string;
  runId?: string;
  severity?: Severity | readonly Severity[];
  category?: Category;
  agent?: AgentId;
  includeSuppressed?: boolean;
  cursor?: string;
  limit?: number;
}

/**
 * Findings explorer: newest run first, then by finding id, in stable pages. The cursor key is the
 * run's `queued_at` plus the finding id.
 */
export async function listFindings(
  db: Database,
  installationIds: InstallationIds,
  filters: FindingFilters = {},
): Promise<Page<StoredFinding>> {
  const limit = clampLimit(filters.limit);
  const severities =
    filters.severity === undefined
      ? undefined
      : ([] as Severity[]).concat(filters.severity as Severity | Severity[]);
  const empty = { items: [], nextCursor: null };
  if (filters.repoId !== undefined && !isUuid(filters.repoId)) return empty;
  if (filters.runId !== undefined && !isUuid(filters.runId)) return empty;
  if (severities?.length === 0) return empty;

  const rows = await db
    .select({ finding: findings, queuedAt: reviewRuns.queuedAt })
    .from(findings)
    .innerJoin(
      reviewRuns,
      and(
        eq(findings.runId, reviewRuns.id),
        eq(findings.installationId, reviewRuns.installationId),
      ),
    )
    .where(
      and(
        inInstallations(findings.installationId, installationIds),
        filters.repoId ? eq(findings.repoId, filters.repoId) : undefined,
        filters.runId ? eq(findings.runId, filters.runId) : undefined,
        severities ? inArray(findings.severity, severities) : undefined,
        filters.category ? eq(findings.category, filters.category) : undefined,
        filters.agent ? eq(findings.agent, filters.agent) : undefined,
        filters.includeSuppressed ? undefined : isNull(findings.suppressedReason),
        filters.cursor ? afterCursor(reviewRuns.queuedAt, findings.id, filters.cursor) : undefined,
      ),
    )
    .orderBy(desc(reviewRuns.queuedAt), desc(findings.id))
    .limit(limit + 1);

  const page = toPage(rows, limit, (r) => ({ at: r.queuedAt, id: r.finding.id }));
  return { items: page.items.map((r) => r.finding), nextCursor: page.nextCursor };
}

/** Count of suppressed findings of a run by reason (PL-07). */
export async function countSuppressedFindings(
  db: Database,
  installationIds: InstallationIds,
  runId: string,
): Promise<Partial<Record<SuppressReason, number>>> {
  if (!isUuid(runId)) return {};
  const rows = await db
    .select({ reason: findings.suppressedReason, count: sql<number>`count(*)::int` })
    .from(findings)
    .where(
      and(
        eq(findings.runId, runId),
        inInstallations(findings.installationId, installationIds),
        isNotNull(findings.suppressedReason),
      ),
    )
    .groupBy(findings.suppressedReason);
  const out: Partial<Record<SuppressReason, number>> = {};
  for (const r of rows) if (r.reason) out[r.reason] = r.count;
  return out;
}

/**
 * Non-suppressed findings per run and severity, for a page of runs (the runs list shows a count per run).
 * Runs without findings are absent from the result.
 */
export async function countFindingsByRun(
  db: Database,
  installationIds: InstallationIds,
  runIds: readonly string[],
): Promise<Map<string, Partial<Record<Severity, number>>>> {
  const ids = runIds.filter(isUuid);
  const out = new Map<string, Partial<Record<Severity, number>>>();
  if (ids.length === 0) return out;
  const rows = await db
    .select({
      runId: findings.runId,
      severity: findings.severity,
      count: sql<number>`count(*)::int`,
    })
    .from(findings)
    .where(
      and(
        inArray(findings.runId, ids),
        inInstallations(findings.installationId, installationIds),
        isNull(findings.suppressedReason),
      ),
    )
    .groupBy(findings.runId, findings.severity);
  for (const row of rows) {
    const counts = out.get(row.runId) ?? {};
    counts[row.severity] = row.count;
    out.set(row.runId, counts);
  }
  return out;
}

/** Marks findings as posted to GitHub. Suppressed findings are never marked. Returns how many changed. */
export async function markFindingsPosted(
  db: Database,
  installationId: string,
  findingIds: readonly string[],
): Promise<number> {
  const ids = findingIds.filter(isUuid);
  if (!isUuid(installationId) || ids.length === 0) return 0;
  const rows = await db
    .update(findings)
    .set({ posted: true })
    .where(
      and(
        eq(findings.installationId, installationId),
        inArray(findings.id, ids),
        isNull(findings.suppressedReason),
      ),
    )
    .returning({ id: findings.id });
  return rows.length;
}

/** A finding of one run, as the engine identifies it (the database id is not known to the publisher). */
export interface FindingKey {
  agent: AgentId;
  fingerprint: string;
}

const keyMatch = (keys: readonly FindingKey[]) =>
  or(...keys.map((k) => and(eq(findings.agent, k.agent), eq(findings.fingerprint, k.fingerprint))));

/**
 * Marks the accepted findings of a run as posted (an inline comment is on the pull request). Idempotent:
 * safe to repeat for a re-processed run. Suppressed findings are never marked. Returns how many changed.
 */
export async function markRunFindingsPosted(
  db: Database,
  installationId: string,
  runId: string,
  keys: readonly FindingKey[],
): Promise<number> {
  if (!isUuid(installationId) || !isUuid(runId) || keys.length === 0) return 0;
  const rows = await db
    .update(findings)
    .set({ posted: true })
    .where(
      and(
        eq(findings.installationId, installationId),
        eq(findings.runId, runId),
        isNull(findings.suppressedReason),
        keyMatch(keys),
      ),
    )
    .returning({ id: findings.id });
  return rows.length;
}

/**
 * Turns accepted findings of a run into suppressed ones: the publisher found that they cannot be posted (their
 * line is not in the diff). Findings already posted are left alone. Returns how many changed.
 */
export async function suppressRunFindings(
  db: Database,
  installationId: string,
  runId: string,
  keys: readonly FindingKey[],
  reason: SuppressReason,
): Promise<number> {
  if (!isUuid(installationId) || !isUuid(runId) || keys.length === 0) return 0;
  return db.transaction(async (tx) => {
    // A suppressed row with the same identity would collide with the one being flipped.
    await tx
      .delete(findings)
      .where(
        and(
          eq(findings.installationId, installationId),
          eq(findings.runId, runId),
          eq(findings.suppressedReason, reason),
          keyMatch(keys),
        ),
      );
    const rows = await tx
      .update(findings)
      .set({ suppressedReason: reason })
      .where(
        and(
          eq(findings.installationId, installationId),
          eq(findings.runId, runId),
          isNull(findings.suppressedReason),
          eq(findings.posted, false),
          keyMatch(keys),
        ),
      )
      .returning({ id: findings.id });
    return rows.length;
  });
}
