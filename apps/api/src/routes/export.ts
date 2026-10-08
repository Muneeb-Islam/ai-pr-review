// CSV export of a repository's runs or findings (PL-08, admin). Data minimisation holds here too: no evidence
// excerpts and no model text beyond the finding's title; the file has what a spreadsheet needs to count and
// filter. Each export is audited.
import {
  countFindingsByRun,
  listFindingsWithRuns,
  listRuns,
  summarizeFeedback,
  type Page,
  type Repo,
} from "@ai-pr-review/db";
import { SEVERITIES } from "@ai-pr-review/shared";
import { toCsv, type Cell } from "../export/csv";
import type { Handlers, Platform } from "../http/platform";
import { audit } from "./audit";

/** The most rows one export holds; more than that is cut and the response says so. */
export const EXPORT_MAX_ROWS = 20_000;
const PAGE_SIZE = 100;

const iso = (date: Date | null) => (date ? date.toISOString() : "");

/** Pages through a list until it ends or the cap is reached. */
async function collect<T>(
  fetchPage: (cursor: string | undefined) => Promise<Page<T>>,
  onPage: (items: T[]) => Promise<void>,
): Promise<boolean> {
  let cursor: string | undefined;
  let rows = 0;
  for (;;) {
    const page = await fetchPage(cursor);
    const room = EXPORT_MAX_ROWS - rows;
    await onPage(page.items.slice(0, room));
    rows += Math.min(page.items.length, room);
    if (!page.nextCursor) return false;
    if (rows >= EXPORT_MAX_ROWS) return true;
    cursor = page.nextCursor;
  }
}

async function runsCsv(platform: Platform, repo: Repo, range: { from?: Date; to?: Date }) {
  const ids = [repo.installationId];
  const rows: Cell[][] = [];
  const truncated = await collect(
    (cursor) =>
      listRuns(platform.db, ids, {
        repoId: repo.id,
        limit: PAGE_SIZE,
        ...(range.from ? { from: range.from } : {}),
        ...(range.to ? { to: range.to } : {}),
        ...(cursor ? { cursor } : {}),
      }),
    async (runs) => {
      const counts = await countFindingsByRun(
        platform.db,
        ids,
        runs.map((r) => r.id),
      );
      for (const run of runs) {
        const seconds =
          run.startedAt && run.finishedAt
            ? Math.round((run.finishedAt.getTime() - run.startedAt.getTime()) / 1000)
            : "";
        rows.push([
          run.id,
          run.prNumber,
          `https://github.com/${repo.fullName}/pull/${run.prNumber}`,
          run.headSha,
          run.baseRef,
          run.trigger,
          run.triggeredBy,
          run.status,
          run.statusReason,
          iso(run.queuedAt),
          iso(run.startedAt),
          iso(run.finishedAt),
          seconds,
          run.parentRunId,
          ...SEVERITIES.map((s) => counts.get(run.id)?.[s] ?? 0),
          run.usage.inputTokens,
          run.usage.outputTokens,
        ]);
      }
    },
  );
  const header = [
    "run_id",
    "pr_number",
    "pr_url",
    "head_sha",
    "base_branch",
    "trigger",
    "triggered_by",
    "status",
    "status_reason",
    "queued_at",
    "started_at",
    "finished_at",
    "duration_seconds",
    "parent_run_id",
    ...SEVERITIES.map((s) => `findings_${s}`),
    "input_tokens",
    "output_tokens",
  ];
  return { csv: toCsv(header, rows), rows: rows.length, truncated };
}

async function findingsCsv(platform: Platform, repo: Repo, range: { from?: Date; to?: Date }) {
  const ids = [repo.installationId];
  const rows: Cell[][] = [];
  const truncated = await collect(
    (cursor) =>
      listFindingsWithRuns(platform.db, ids, {
        repoIds: [repo.id],
        status: "all",
        limit: PAGE_SIZE,
        ...(range.from ? { from: range.from } : {}),
        ...(range.to ? { to: range.to } : {}),
        ...(cursor ? { cursor } : {}),
      }),
    async (items) => {
      const feedback = await summarizeFeedback(
        platform.db,
        ids,
        items.map((i) => i.finding.id),
        undefined,
      );
      for (const { finding: f, run } of items) {
        const votes = feedback.get(f.id)!;
        rows.push([
          f.id,
          run.id,
          run.prNumber,
          run.headSha,
          iso(run.queuedAt),
          f.agent,
          f.category,
          f.severity,
          Math.round(f.confidence * 100) / 100,
          f.title,
          f.filePath,
          f.startLine,
          f.endLine,
          f.suppressedReason ? "suppressed" : f.posted ? "posted" : "summary_only",
          f.suppressedReason,
          votes.useful,
          votes.false_positive,
          votes.known,
        ]);
      }
    },
  );
  const header = [
    "finding_id",
    "run_id",
    "pr_number",
    "head_sha",
    "run_queued_at",
    "agent",
    "category",
    "severity",
    "confidence",
    "title",
    "file_path",
    "start_line",
    "end_line",
    "status",
    "suppressed_reason",
    "votes_useful",
    "votes_false_positive",
    "votes_known",
  ];
  return { csv: toCsv(header, rows), rows: rows.length, truncated };
}

export const exportHandlers: Pick<Handlers, "exportCsv"> = {
  async exportCsv({ platform, auth, repo, query, reply }) {
    const range = {
      ...(query.from ? { from: new Date(query.from) } : {}),
      ...(query.to ? { to: new Date(query.to) } : {}),
    };
    const result =
      query.kind === "runs"
        ? await runsCsv(platform, repo, range)
        : await findingsCsv(platform, repo, range);

    await audit(platform.db, repo.installationId, auth.user.id, "export.csv", `repo:${repo.id}`, {
      kind: query.kind,
      rows: result.rows,
      truncated: result.truncated,
    });

    const day = (platform.now?.() ?? new Date()).toISOString().slice(0, 10);
    const name = repo.fullName.replace(/[^A-Za-z0-9._-]+/g, "-");
    reply
      .header("content-type", "text/csv; charset=utf-8")
      .header("content-disposition", `attachment; filename="${name}-${query.kind}-${day}.csv"`)
      .header("x-export-truncated", String(result.truncated))
      .send(result.csv);
    return undefined;
  },
};
