import { and, asc, desc, eq, inArray, isNotNull, isNull, sql } from "drizzle-orm";
import type { Finding, Severity, SuppressReason, AgentId, Category } from "@ai-pr-review/shared";
import type { Database } from "../client";
import { InvalidInputError } from "../errors";
import { afterCursor, clampLimit, toPage, type Page } from "../pagination";
import { findings, reviewRuns } from "../schema";
import { inInstallations, isUuid, type InstallationIds } from "../scope";
import type { StoredFinding } from "../types";
import { requireRun, truncateEvidence } from "./internal";

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
    .values(
      input.map((f) => ({
        installationId,
        runId,
        repoId: run.repoId,
        agent: f.agent,
        category: f.category,
        severity: f.severity,
        confidence: f.confidence,
        title: f.title,
        filePath: f.filePath ?? null,
        startLine: f.startLine ?? null,
        endLine: f.endLine ?? null,
        evidence: truncateEvidence(f.evidence),
        impact: f.impact,
        recommendation: f.recommendation,
        suggestedTest: f.suggestedTest ?? null,
        fingerprint: f.fingerprint,
        posted: f.posted ?? false,
        suppressedReason: f.suppressedReason ?? null,
      })),
    )
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
