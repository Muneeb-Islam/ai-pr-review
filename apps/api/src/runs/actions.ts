// Re-run and cancel (AC-21, Phase 13): the two things a person can do to a run from the dashboard. A re-run goes
// through `requestRun`, the one path every trigger uses (the pull request event, the `/ai-review` comment and the
// Check Run's "Re-run" button), so the guards, the superseding of older runs, the queued Check Run and the queue
// hand-off are the same whatever started the run.
import {
  getInstallation,
  IllegalTransitionError,
  transitionRun,
  type Repo,
  type Run,
} from "@ai-pr-review/db";
import { badGateway, conflict } from "../http/errors";
import { requestRun } from "../webhooks/runs";
import type { WebhookDeps } from "../webhooks/types";

const splitFullName = (fullName: string) => {
  const [owner = "", repo = ""] = fullName.split("/");
  return { owner, repo };
};

export interface RerunResult {
  run: Run;
  /** False when an identical run for the same commit was already queued or running and was reused. */
  created: boolean;
}

/** What the dashboard's run actions need: the database, GitHub, the queue and the signals. */
export class RunActions {
  constructor(private readonly deps: WebhookDeps) {}

  /**
   * A new `queued` run for the commit the pull request points at now (not the one `run` reviewed: a re-run of an
   * old commit would only be superseded or review stale code), linked to `run` by `parent_run_id`. Older active
   * runs of the pull request are superseded like for any push. Throws a 409 when the pull request is closed or the
   * repository or installation is no longer active; a GitHub failure is a 502.
   */
  async rerun(input: { run: Run; repo: Repo; requestedBy: string }): Promise<RerunResult> {
    const { deps } = this;
    const { run, repo } = input;
    const installation = await getInstallation(deps.db, [run.installationId], run.installationId);
    if (!installation || installation.status !== "active") {
      throw conflict(
        "installation_inactive",
        "The GitHub App is no longer active on this account.",
      );
    }
    if (!repo.active) {
      throw conflict(
        "repository_inactive",
        "The repository is no longer part of the installation.",
      );
    }

    let snapshot;
    try {
      snapshot = await deps.github.fetchPullRequest(
        installation.githubInstallationId,
        splitFullName(repo.fullName),
        run.prNumber,
      );
    } catch (err) {
      if ((err as { status?: number }).status === 404) {
        throw conflict("pull_request_gone", "GitHub could not find the pull request.");
      }
      deps.logger.warn("Could not read the pull request for a re-run", {
        run: run.id,
        ...((err as { status?: number }).status
          ? { status: (err as { status?: number }).status as number }
          : {}),
      });
      throw badGateway("GitHub did not answer. Try again shortly.");
    }
    if (snapshot.state !== "open") {
      throw conflict(
        "pull_request_closed",
        "The pull request is closed, so there is nothing to review.",
      );
    }

    const result = await requestRun(deps, {
      installation,
      repo,
      trigger: "dashboard_rerun",
      triggeredBy: input.requestedBy,
      pr: snapshot.pr,
      baseSha: snapshot.baseSha,
      parentRunId: run.id,
    });
    if (!result.run) throw new Error("A re-run produced no run.");
    return { run: result.run, created: result.outcome !== "run_exists" };
  }

  /**
   * Stops a queued or running run: the status changes first (so a worker that is still going loses its fence and
   * writes nothing more), then the dashboard hears of it and any worker executing it is told to stop. The Check Run
   * is closed by the worker when it sees the run stopped. A 409 when the run has already finished.
   */
  async cancel(input: { run: Run; requestedBy: string }): Promise<Run> {
    const { deps } = this;
    let cancelled: Run;
    try {
      cancelled = await transitionRun(
        deps.db,
        input.run.installationId,
        input.run.id,
        "cancelled",
        {
          reason: `Cancelled by ${input.requestedBy}.`,
        },
      );
    } catch (err) {
      if (err instanceof IllegalTransitionError) {
        throw conflict(
          "run_not_active",
          "The run has already finished, so it cannot be cancelled.",
        );
      }
      throw err;
    }
    await deps.signals?.publishUpdated({
      runId: cancelled.id,
      installationId: cancelled.installationId,
      repoId: cancelled.repoId,
      status: cancelled.status,
    });
    await deps.signals?.publishCancel(cancelled.id, "cancelled");
    return cancelled;
  }
}
