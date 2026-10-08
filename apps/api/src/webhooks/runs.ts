import type { PullRequestInfo } from "@ai-pr-review/core";
import { decide } from "@ai-pr-review/core";
import {
  createRun,
  createRunSupersedingOlder,
  getRepoSettings,
  updateRunDetails,
  type Installation,
  type Repo,
  type Run,
} from "@ai-pr-review/db";
import { ConfigError, resolveRepoConfig, type RunTrigger } from "@ai-pr-review/shared";
import { allowAllQuota, type HandlerResult, type WebhookDeps } from "./types";

export interface RunRequest {
  installation: Installation;
  repo: Repo;
  trigger: RunTrigger;
  triggeredBy?: string;
  pr: PullRequestInfo;
  baseSha: string;
  /** The run being re-run (Check Run "re-run" button). */
  parentRunId?: string;
}

/** Tells the dashboard a run changed (the row is already written). Signals never reject. */
async function announce(deps: WebhookDeps, run: Run): Promise<void> {
  await deps.signals?.publishUpdated({
    runId: run.id,
    installationId: run.installationId,
    repoId: run.repoId,
    status: run.status,
  });
}

const splitFullName = (fullName: string) => {
  const [owner = "", repo = ""] = fullName.split("/");
  return { owner, repo };
};

/**
 * Decides what a pull request event leads to and records it (design §7):
 *
 *  1. guards: repository enabled, then `decide()` (fork policy, target branch, draft), then the quota hook.
 *     A guard that says no creates a `skipped` run with the reason.
 *  2. otherwise the run is created `queued`, older active runs of the same PR are superseded, a queued
 *     Check Run is created and the run is handed to the queue.
 *
 * Idempotent: an identical active run (same PR, head SHA and trigger) is reused, not duplicated.
 * Installation and repository state are checked by the caller.
 */
export async function requestRun(deps: WebhookDeps, req: RunRequest): Promise<HandlerResult> {
  const { db, logger } = deps;
  const { installation, repo, pr } = req;
  const log = logger.child({ repo: repo.fullName, pr: pr.number, trigger: req.trigger });
  const base = {
    repoId: repo.id,
    prNumber: pr.number,
    headSha: pr.headSha,
    baseSha: req.baseSha,
    baseRef: pr.baseRef,
    trigger: req.trigger,
    ...(req.triggeredBy ? { triggeredBy: req.triggeredBy } : {}),
    ...(req.parentRunId ? { parentRunId: req.parentRunId } : {}),
  };
  const result = (outcome: string, run?: Run): HandlerResult => ({
    outcome,
    installationId: installation.id,
    ...(run ? { run } : {}),
  });
  const skip = async (reason: string): Promise<HandlerResult> => {
    const run = await createRun(db, installation.id, { ...base, skip: { reason } });
    log.info("Run skipped", { run: run.id, reason });
    await announce(deps, run);
    return result("run_skipped", run);
  };

  if (!repo.enabled) return skip(`Reviews are disabled for ${repo.fullName}.`);

  let config;
  try {
    const settings = await getRepoSettings(db, [installation.id], repo.id);
    config = resolveRepoConfig(settings?.config ?? {});
  } catch (err) {
    if (!(err instanceof ConfigError)) throw err;
    return skip(`The stored settings for ${repo.fullName} are invalid: ${err.problems.join("; ")}`);
  }

  const decision = decide(req.trigger, pr, config);
  if (decision.action === "skip") return skip(decision.reason);

  // The quota and queue limits are decided inside the transaction that creates the run, under a lock per
  // installation (a burst of events cannot all pass a limit that each would pass alone). A duplicate of a run that is
  // already active never reaches the decision, so a redelivery cannot leave a skipped run behind.
  const created = await createRunSupersedingOlder(db, installation.id, base, (tx) =>
    (deps.quota ?? allowAllQuota)({
      installationId: installation.id,
      repoId: repo.id,
      trigger: req.trigger,
      db: tx,
    }),
  );
  if ("rejected" in created) return skip(created.rejected);
  const { run, superseded, duplicate } = created;
  if (duplicate) log.info("Run already queued for this head", { run: run.id });
  else log.info("Run queued", { run: run.id, superseded: superseded.length });
  if (!duplicate) {
    // A superseded run that a worker is executing stops at its next check; the message makes it immediate.
    for (const old of superseded) {
      await announce(deps, old);
      await deps.signals?.publishCancel(old.id, "superseded");
    }
    await announce(deps, run);
  }

  // Also for a duplicate: a retried delivery heals a first attempt that failed after creating the run.
  // Enqueueing is idempotent per run id.
  if (run.checkRunId === null && run.status === "queued") {
    await attachQueuedCheckRun(deps, installation, repo, run);
  }
  await deps.queue.enqueue(run.id);
  return result(duplicate ? "run_exists" : "run_queued", run);
}

/**
 * Creates the queued Check Run (AC-16). A GitHub failure (missing permission, outage) must not lose the
 * review: it is logged and recorded as a warning on the run.
 */
async function attachQueuedCheckRun(
  deps: WebhookDeps,
  installation: Installation,
  repo: Repo,
  run: Run,
): Promise<void> {
  try {
    const checkRunId = await deps.github.createQueuedCheckRun(
      installation.githubInstallationId,
      splitFullName(repo.fullName),
      {
        headSha: run.headSha,
        externalId: run.id,
        detailsUrl: new URL(`/runs/${run.id}`, deps.publicUrl).toString(),
      },
    );
    await updateRunDetails(deps.db, installation.id, run.id, { checkRunId });
  } catch (err) {
    const status = (err as { status?: number }).status;
    deps.logger.warn("Could not create the queued Check Run", {
      run: run.id,
      ...(status ? { status } : {}),
    });
    await updateRunDetails(deps.db, installation.id, run.id, {
      warnings: [
        ...run.warnings,
        "The queued Check Run could not be created on GitHub; the review continues.",
      ],
    });
  }
}
