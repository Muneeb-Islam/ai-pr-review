// The findings explorer, one finding, feedback on it, and the history of a pull request (UI-05, AC-19).
import {
  InvalidCursorError,
  listFindingsWithRuns,
  listPullHistory,
  setFeedback,
  summarizeFeedback,
} from "@ai-pr-review/db";
import type { Severity } from "@ai-pr-review/shared";
import { conflict, notFound, validationError } from "../http/errors";
import type { Handlers } from "../http/platform";
import { toExplorerFindings, toFeedbackDto } from "../findings/dto";
import { compareRuns } from "../findings/history";
import { accessibleRepos, toRunSummary } from "./runs";

type FindingsHandlers = Pick<
  Handlers,
  "listFindings" | "getFinding" | "giveFeedback" | "getPullHistory"
>;

export const findingsHandlers: FindingsHandlers = {
  async listFindings({ platform, auth, query }) {
    const repos = await accessibleRepos(platform, auth);
    // A repo filter naming a repository the user cannot reach is an empty list, like any other filter.
    const repoIds = query.repo_id
      ? [...repos.keys()].filter((id) => id === query.repo_id)
      : [...repos.keys()];
    const installationIds = [...new Set([...repos.values()].map((r) => r.installationId))];

    let page;
    try {
      page = await listFindingsWithRuns(platform.db, installationIds, {
        repoIds,
        ...(query.run_id ? { runId: query.run_id } : {}),
        ...(query.severity ? { severity: query.severity } : {}),
        ...(query.category ? { category: query.category } : {}),
        ...(query.agent ? { agent: query.agent } : {}),
        ...(query.status ? { status: query.status } : {}),
        ...(query.path ? { path: query.path } : {}),
        ...(query.from ? { from: new Date(query.from) } : {}),
        ...(query.to ? { to: new Date(query.to) } : {}),
        ...(query.cursor ? { cursor: query.cursor } : {}),
        ...(query.limit ? { limit: query.limit } : {}),
      });
    } catch (err) {
      if (err instanceof InvalidCursorError) throw validationError(["cursor: not a valid cursor"]);
      throw err;
    }

    const items = await toExplorerFindings(
      platform.db,
      installationIds,
      auth.user.id,
      page.items,
      (repoId) => repos.get(repoId)?.fullName ?? "",
    );
    return { items, next_cursor: page.nextCursor };
  },

  async getFinding({ platform, auth, finding, run, repo }) {
    const [dto] = await toExplorerFindings(
      platform.db,
      [finding.installationId],
      auth.user.id,
      [{ finding, run }],
      () => repo.fullName,
    );
    return dto!;
  },

  async giveFeedback({ platform, auth, finding, body }) {
    // A finding the review dropped was never shown to anyone: there is nothing to rate.
    if (finding.suppressedReason !== null) {
      throw conflict("finding_suppressed", "This finding was not reported, so it cannot be rated.");
    }
    const note = body.note && body.note !== "" ? body.note : undefined;
    await setFeedback(platform.db, finding.installationId, {
      findingId: finding.id,
      userId: auth.user.id,
      verdict: body.verdict,
      ...(note !== undefined ? { note } : {}),
    });
    const summary = await summarizeFeedback(
      platform.db,
      [finding.installationId],
      [finding.id],
      auth.user.id,
    );
    return { feedback: toFeedbackDto(summary.get(finding.id)!) };
  },

  async getPullHistory({ platform, repo, params }) {
    const history = await listPullHistory(
      platform.db,
      [repo.installationId],
      repo.id,
      params.number,
    );
    if (history.runs.length === 0) throw notFound();
    const changes = compareRuns(history.runs);
    return {
      repo_id: repo.id,
      repo_full_name: repo.fullName,
      pr_number: params.number,
      pr_url: `https://github.com/${repo.fullName}/pull/${params.number}`,
      runs: history.runs.map((entry, i) => ({
        run: toRunSummary(entry.run, repo, countBySeverity(entry.findings)),
        changes: changes[i]!,
      })),
      truncated: history.truncated,
    };
  },
};

function countBySeverity(findings: ReadonlyArray<{ severity: Severity }>) {
  const counts: Partial<Record<Severity, number>> = {};
  for (const f of findings) counts[f.severity] = (counts[f.severity] ?? 0) + 1;
  return counts;
}
