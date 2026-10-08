// Reads for the history and findings explorer (UI-05): findings across runs with the run they belong to,
// feedback totals, the GitHub comment behind a finding, and every run of one pull request. Tenant-scoped like
// the rest of this folder: each function takes the caller's installation ids.
import { and, asc, desc, eq, gte, ilike, inArray, isNotNull, isNull, lte, sql } from "drizzle-orm";
import type {
  AgentId,
  AgentRunStatus,
  Category,
  FeedbackVerdict,
  Severity,
} from "@ai-pr-review/shared";
import type { Database } from "../client";
import { afterCursor, clampLimit, toPage, type Page } from "../pagination";
import { agentRuns, findingFeedback, findings, postedComments, reviewRuns } from "../schema";
import { inInstallations, isUuid, type InstallationIds } from "../scope";
import type { Run, StoredFinding } from "../types";

/** `posted` has an inline comment, `summary_only` does not, `suppressed` was dropped; `all` is all three. */
export type FindingStatusFilter = "posted" | "summary_only" | "suppressed" | "all";

export interface ExplorerFilters {
  /** The repositories the caller may reach; an empty list matches nothing. */
  repoIds?: readonly string[];
  runId?: string;
  severity?: Severity;
  category?: Category;
  agent?: AgentId;
  /** Default: reported findings (posted and summary-only), not suppressed ones. */
  status?: FindingStatusFilter;
  /** Case-insensitive part of the file path (wildcards in the text are taken literally). */
  path?: string;
  /** Inclusive bounds on the time the run was queued. */
  from?: Date;
  to?: Date;
  cursor?: string;
  limit?: number;
}

/** A finding and the run (and so the pull request) that produced it. */
export interface FindingWithRun {
  finding: StoredFinding;
  run: Pick<Run, "id" | "repoId" | "prNumber" | "headSha" | "queuedAt">;
}

const runColumns = {
  id: reviewRuns.id,
  repoId: reviewRuns.repoId,
  prNumber: reviewRuns.prNumber,
  headSha: reviewRuns.headSha,
  queuedAt: reviewRuns.queuedAt,
};

/** Text for `ILIKE` with `%`, `_` and `\` taken literally. */
const escapeLike = (text: string): string => text.replace(/[\\%_]/g, (c) => `\\${c}`);

const statusCondition = (status: FindingStatusFilter | undefined) => {
  switch (status) {
    case "all":
      return undefined;
    case "suppressed":
      return isNotNull(findings.suppressedReason);
    case "posted":
      return and(isNull(findings.suppressedReason), eq(findings.posted, true));
    case "summary_only":
      return and(isNull(findings.suppressedReason), eq(findings.posted, false));
    default:
      return isNull(findings.suppressedReason);
  }
};

/**
 * Findings across the caller's runs, newest run first, in stable pages (cursor key: the run's `queued_at` and
 * the finding id). Filters combine with AND.
 */
export async function listFindingsWithRuns(
  db: Database,
  installationIds: InstallationIds,
  filters: ExplorerFilters = {},
): Promise<Page<FindingWithRun>> {
  const limit = clampLimit(filters.limit);
  const empty = { items: [], nextCursor: null };
  const repoIds = filters.repoIds?.filter(isUuid);
  if (repoIds?.length === 0) return empty;
  if (filters.runId !== undefined && !isUuid(filters.runId)) return empty;

  const rows = await db
    .select({ finding: findings, run: runColumns })
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
        repoIds ? inArray(findings.repoId, repoIds) : undefined,
        filters.runId ? eq(findings.runId, filters.runId) : undefined,
        filters.severity ? eq(findings.severity, filters.severity) : undefined,
        filters.category ? eq(findings.category, filters.category) : undefined,
        filters.agent ? eq(findings.agent, filters.agent) : undefined,
        statusCondition(filters.status),
        filters.path ? ilike(findings.filePath, `%${escapeLike(filters.path)}%`) : undefined,
        filters.from ? gte(reviewRuns.queuedAt, filters.from) : undefined,
        filters.to ? lte(reviewRuns.queuedAt, filters.to) : undefined,
        filters.cursor ? afterCursor(reviewRuns.queuedAt, findings.id, filters.cursor) : undefined,
      ),
    )
    .orderBy(desc(reviewRuns.queuedAt), desc(findings.id))
    .limit(limit + 1);

  const page = toPage(rows, limit, (r) => ({ at: r.run.queuedAt, id: r.finding.id }));
  return { items: page.items, nextCursor: page.nextCursor };
}

export async function getFindingWithRun(
  db: Database,
  installationIds: InstallationIds,
  findingId: string,
): Promise<FindingWithRun | undefined> {
  if (!isUuid(findingId)) return undefined;
  const [row] = await db
    .select({ finding: findings, run: runColumns })
    .from(findings)
    .innerJoin(
      reviewRuns,
      and(
        eq(findings.runId, reviewRuns.id),
        eq(findings.installationId, reviewRuns.installationId),
      ),
    )
    .where(
      and(eq(findings.id, findingId), inInstallations(findings.installationId, installationIds)),
    );
  return row;
}

// ---------- feedback ----------

export interface FeedbackSummary {
  useful: number;
  false_positive: number;
  known: number;
  /** What `userId` said; null when they have not voted. */
  mine: { verdict: FeedbackVerdict; note: string | null } | null;
}

const NO_FEEDBACK = (): FeedbackSummary => ({ useful: 0, false_positive: 0, known: 0, mine: null });

/** Votes per finding (every finding asked about has an entry) and the caller's own verdict. */
export async function summarizeFeedback(
  db: Database,
  installationIds: InstallationIds,
  findingIds: readonly string[],
  userId: string | undefined,
): Promise<Map<string, FeedbackSummary>> {
  const ids = findingIds.filter(isUuid);
  const out = new Map<string, FeedbackSummary>(findingIds.map((id) => [id, NO_FEEDBACK()]));
  if (ids.length === 0) return out;

  const where = and(
    inArray(findingFeedback.findingId, ids),
    inInstallations(findingFeedback.installationId, installationIds),
  );
  const [counts, mine] = await Promise.all([
    db
      .select({
        findingId: findingFeedback.findingId,
        verdict: findingFeedback.verdict,
        count: sql<number>`count(*)::int`,
      })
      .from(findingFeedback)
      .where(where)
      .groupBy(findingFeedback.findingId, findingFeedback.verdict),
    userId && isUuid(userId)
      ? db
          .select({
            findingId: findingFeedback.findingId,
            verdict: findingFeedback.verdict,
            note: findingFeedback.note,
          })
          .from(findingFeedback)
          .where(and(where, eq(findingFeedback.userId, userId)))
      : Promise.resolve([]),
  ]);
  for (const row of counts) {
    const summary = out.get(row.findingId);
    if (summary) summary[row.verdict] = row.count;
  }
  for (const row of mine) {
    const summary = out.get(row.findingId);
    if (summary) summary.mine = { verdict: row.verdict, note: row.note };
  }
  return out;
}

// ---------- GitHub comments ----------

/**
 * The GitHub id of the inline comment posted for each finding, keyed `${runId}:${fingerprint}`. Findings
 * without an inline comment are absent.
 */
export async function findInlineCommentIds(
  db: Database,
  installationIds: InstallationIds,
  keys: ReadonlyArray<{ runId: string; fingerprint: string }>,
): Promise<Map<string, number>> {
  const runIds = [...new Set(keys.map((k) => k.runId).filter(isUuid))];
  const out = new Map<string, number>();
  if (runIds.length === 0) return out;
  const wanted = new Set(keys.map((k) => `${k.runId}:${k.fingerprint}`));
  const rows = await db
    .select({
      runId: postedComments.runId,
      fingerprint: postedComments.fingerprint,
      githubId: postedComments.githubId,
    })
    .from(postedComments)
    .where(
      and(
        inArray(postedComments.runId, runIds),
        eq(postedComments.kind, "review_comment"),
        inInstallations(postedComments.installationId, installationIds),
      ),
    )
    .orderBy(asc(postedComments.githubId));
  for (const row of rows) {
    const key = `${row.runId}:${row.fingerprint}`;
    if (row.fingerprint && wanted.has(key) && !out.has(key)) out.set(key, row.githubId);
  }
  return out;
}

// ---------- history of one pull request ----------

export interface PullHistoryRun {
  run: Run;
  /** Findings the run reported (not suppressed). */
  findings: StoredFinding[];
  agents: Array<{ agent: AgentId; status: AgentRunStatus }>;
}

export interface PullHistory {
  /** Oldest first. */
  runs: PullHistoryRun[];
  /** The pull request has more runs than `limit`; the oldest are left out. */
  truncated: boolean;
}

/** The latest `limit` runs of a pull request with their reported findings and agent outcomes, oldest first. */
export async function listPullHistory(
  db: Database,
  installationIds: InstallationIds,
  repoId: string,
  prNumber: number,
  limit = 100,
): Promise<PullHistory> {
  if (!isUuid(repoId) || !Number.isInteger(prNumber)) return { runs: [], truncated: false };
  const newestFirst = await db
    .select()
    .from(reviewRuns)
    .where(
      and(
        inInstallations(reviewRuns.installationId, installationIds),
        eq(reviewRuns.repoId, repoId),
        eq(reviewRuns.prNumber, prNumber),
      ),
    )
    .orderBy(desc(reviewRuns.queuedAt), desc(reviewRuns.id))
    .limit(limit + 1);
  const truncated = newestFirst.length > limit;
  const runs = newestFirst.slice(0, limit).reverse();
  if (runs.length === 0) return { runs: [], truncated: false };

  const runIds = runs.map((r) => r.id);
  const [stored, agents] = await Promise.all([
    db
      .select()
      .from(findings)
      .where(
        and(
          inArray(findings.runId, runIds),
          inInstallations(findings.installationId, installationIds),
          isNull(findings.suppressedReason),
        ),
      )
      // Enum order is critical, high, medium, low, info.
      .orderBy(
        asc(findings.severity),
        asc(findings.filePath),
        asc(findings.startLine),
        asc(findings.id),
      ),
    db
      .select({ runId: agentRuns.runId, agent: agentRuns.agent, status: agentRuns.status })
      .from(agentRuns)
      .where(
        and(
          inArray(agentRuns.runId, runIds),
          inInstallations(agentRuns.installationId, installationIds),
        ),
      ),
  ]);

  return {
    truncated,
    runs: runs.map((run) => ({
      run,
      findings: stored.filter((f) => f.runId === run.id),
      agents: agents
        .filter((a) => a.runId === run.id)
        .map(({ agent, status }) => ({ agent, status })),
    })),
  };
}
