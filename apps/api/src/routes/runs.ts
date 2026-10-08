import {
  countFindingsByRun,
  countSuppressedFindings,
  InvalidCursorError,
  listAgentRuns,
  listFindingsForRun,
  listRepositories,
  listRuns,
  type Repo,
  type Run,
} from "@ai-pr-review/db";
import {
  SEVERITIES,
  type CoverageDto,
  type CoverageSummary,
  type FindingTracking,
  type RunStatus,
  type Severity,
  type TrackingDto,
} from "@ai-pr-review/shared";
import { unavailable, validationError } from "../http/errors";
import type { Handlers, Platform } from "../http/platform";
import type { AuthContext } from "../auth/sessions";
import { toFindingDtos } from "../findings/dto";
import { audit } from "./audit";

type RunsHandlers = Pick<Handlers, "listRuns" | "getRun" | "rerunRun" | "cancelRun">;

const iso = (date: Date) => date.toISOString();
const isoOrNull = (date: Date | null | undefined) => (date ? date.toISOString() : null);

const githubUrl = (fullName: string, path: string) => `https://github.com/${fullName}/${path}`;

const countsOf = (counts: Partial<Record<Severity, number>> | undefined) =>
  Object.fromEntries(SEVERITIES.map((s) => [s, counts?.[s] ?? 0])) as Record<Severity, number>;

export function toRunSummary(
  run: Run,
  repo: Pick<Repo, "fullName">,
  counts?: Partial<Record<Severity, number>>,
) {
  return {
    id: run.id,
    repo_id: run.repoId,
    repo_full_name: repo.fullName,
    pr_number: run.prNumber,
    pr_url: githubUrl(repo.fullName, `pull/${run.prNumber}`),
    head_sha: run.headSha,
    base_ref: run.baseRef,
    trigger: run.trigger,
    triggered_by: run.triggeredBy,
    status: run.status,
    status_reason: run.statusReason,
    queued_at: iso(run.queuedAt),
    started_at: isoOrNull(run.startedAt),
    finished_at: isoOrNull(run.finishedAt),
    parent_run_id: run.parentRunId,
    finding_counts: countsOf(counts),
  };
}

/** The stored coverage record as the API's snake_case shape: counts, paths and line ranges only. */
export const toCoverageDto = (c: CoverageSummary): CoverageDto => ({
  status: c.status,
  reason: c.reason ?? null,
  reason_code: c.reasonCode ?? null,
  changed_line_coverage: c.changedLineCoverage ?? null,
  covered_lines: c.coveredLines ?? null,
  total_lines: c.totalLines ?? null,
  files: (c.files ?? []).map((f) => ({
    path: f.path,
    status: f.status,
    covered_lines: f.coveredLines,
    total_lines: f.totalLines,
    uncovered: f.uncovered,
    uncovered_functions: f.uncoveredFunctions ?? [],
    covered_branches: f.coveredBranches ?? null,
    total_branches: f.totalBranches ?? null,
  })),
  artifact_name: c.artifact?.name ?? null,
  artifact_run_id: c.artifact?.runId ?? null,
  observations: c.observations,
});

/** The stored comparison with the previous review as the API's snake_case shape. */
export const toTrackingDto = (t: FindingTracking): TrackingDto => ({
  previous_run_id: t.previousRunId,
  previous_head_sha: t.previousHeadSha,
  items: t.items.map((i) => ({
    state: i.state,
    agent: i.agent,
    category: i.category,
    severity: i.severity,
    title: i.title,
    file_path: i.filePath ?? null,
    start_line: i.startLine ?? null,
    reason: i.reason ?? null,
  })),
});

/**
 * The repositories the user may reach right now, by id. Repository access is authoritative (design §9): an
 * installation row alone never grants data, so everything about runs is filtered through this set.
 */
export async function accessibleRepos(
  platform: Platform,
  auth: AuthContext,
  filters: { installationId?: string } = {},
): Promise<Map<string, Repo>> {
  const access = await platform.access.listRepoAccess({
    id: auth.user.id,
    login: auth.user.login,
  });
  const installationIds = [...new Set([...access.values()].map((a) => a.installationId))];
  const repos = await listRepositories(platform.db, installationIds, {
    active: true,
    ...(filters.installationId ? { installationId: filters.installationId } : {}),
  });
  return new Map(
    repos
      .filter((repo) => access.get(repo.id)?.installationId === repo.installationId)
      .map((repo) => [repo.id, repo]),
  );
}

export const runHandlers: RunsHandlers = {
  async listRuns({ platform, auth, query }) {
    const repos = await accessibleRepos(platform, auth);
    const status = query.status
      ? (query.status.split(",").map((s) => s.trim()) as RunStatus[])
      : undefined;
    // A repo filter naming a repository the user cannot reach is an empty list, like any other filter.
    const repoIds = query.repo_id
      ? [...repos.keys()].filter((id) => id === query.repo_id)
      : [...repos.keys()];
    const installationIds = [...new Set([...repos.values()].map((r) => r.installationId))];

    let page;
    try {
      page = await listRuns(platform.db, installationIds, {
        repoIds,
        ...(status ? { status } : {}),
        ...(query.branch ? { baseRef: query.branch } : {}),
        ...(query.author ? { triggeredBy: query.author } : {}),
        ...(query.severity ? { severity: query.severity } : {}),
        ...(query.from ? { from: new Date(query.from) } : {}),
        ...(query.to ? { to: new Date(query.to) } : {}),
        ...(query.cursor ? { cursor: query.cursor } : {}),
        ...(query.limit ? { limit: query.limit } : {}),
      });
    } catch (err) {
      if (err instanceof InvalidCursorError) throw validationError(["cursor: not a valid cursor"]);
      throw err;
    }

    const counts = await countFindingsByRun(
      platform.db,
      installationIds,
      page.items.map((run) => run.id),
    );
    return {
      items: page.items.map((run) => toRunSummary(run, repos.get(run.repoId)!, counts.get(run.id))),
      next_cursor: page.nextCursor,
    };
  },

  async getRun({ platform, auth, run, repo }) {
    const scope = [run.installationId];
    const [agentRuns, findings, suppressed, counts] = await Promise.all([
      listAgentRuns(platform.db, scope, run.id),
      listFindingsForRun(platform.db, scope, run.id),
      countSuppressedFindings(platform.db, scope, run.id),
      countFindingsByRun(platform.db, scope, [run.id]),
    ]);
    return {
      ...toRunSummary(run, repo, counts.get(run.id)),
      base_sha: run.baseSha,
      check_run_url:
        run.checkRunId === null ? null : githubUrl(repo.fullName, `runs/${run.checkRunId}`),
      warnings: run.warnings,
      usage: { input_tokens: run.usage.inputTokens, output_tokens: run.usage.outputTokens },
      agent_runs: agentRuns.map((a) => ({
        agent: a.agent,
        status: a.status,
        started_at: isoOrNull(a.startedAt),
        duration_ms: a.durationMs,
        input_tokens: a.inputTokens,
        output_tokens: a.outputTokens,
        retries: a.retries,
        warnings: a.warnings,
      })),
      findings: await toFindingDtos(
        platform.db,
        scope,
        auth.user.id,
        findings.map((finding) => ({ finding, run })),
        () => repo.fullName,
      ),
      suppressed_counts: suppressed,
      skipped_files: run.skippedFiles,
      coverage: run.coverage === null ? null : toCoverageDto(run.coverage),
      tracking: run.tracking === null ? null : toTrackingDto(run.tracking),
      final_review: run.finalReview,
    };
  },

  async rerunRun({ platform, auth, run, repo }) {
    if (!platform.runActions) throw unavailable("Re-running is not available right now.");
    const { run: next, created } = await platform.runActions.rerun({
      run,
      repo,
      requestedBy: auth.user.login,
    });
    await audit(platform.db, run.installationId, auth.user.id, "run.rerun", `run:${run.id}`, {
      new_run_id: next.id,
      head_sha: next.headSha,
      status: next.status,
      created,
    });
    return { run: toRunSummary(next, repo), created };
  },

  async cancelRun({ platform, auth, run, repo }) {
    if (!platform.runActions) throw unavailable("Cancelling is not available right now.");
    const cancelled = await platform.runActions.cancel({ run, requestedBy: auth.user.login });
    await audit(platform.db, run.installationId, auth.user.id, "run.cancel", `run:${run.id}`, {
      from_status: run.status,
    });
    return { run: toRunSummary(cancelled, repo) };
  },
};
