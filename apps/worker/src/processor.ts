// The run lifecycle in the worker (design §7, Phase 8): claim, load, check, collect context, run the review
// engine, persist, publish, finish. The database is the source of truth: every state change is a conditional
// write fenced by the attempt number the worker claimed, so a retried job, a second worker or the sweeper can
// never double-process or overwrite a run.
import {
  collectContext,
  governorLimits,
  redactSecrets,
  runReview,
  trackFindings,
  createProvider,
  validateBaseUrl,
  DecryptionError,
  RunGovernor,
  type ContextClient,
  type EngineResult,
  type Keyring,
  type PreviousFinding,
  type ReviewContext,
} from "@ai-pr-review/core";
import {
  getInstallation,
  getInstallationSettings,
  getPlatformAiSettings,
  getPreviousReview,
  getRepoSettings,
  type Database,
  type Run,
} from "@ai-pr-review/db";
import {
  checkDailyQuota,
  claimRun,
  finishClaimedRun,
  getRepositoryById,
  getRunById,
  requeueRun,
  saveRunResults,
  touchRunHeartbeat,
  type FinishOptions,
  type RunResults,
} from "@ai-pr-review/db/system";
import type { RunSignals } from "@ai-pr-review/queue";
import {
  ConfigError,
  mergeDashboardLayers,
  resolveEffectiveSettings,
  utcDayStart,
  type Logger,
  type FindingTracking,
  type QuotaLimits,
  type RunStatus,
} from "@ai-pr-review/shared";
import { ActiveRuns, stopReason, type StopReason } from "./activeRuns";
import { getDecryptedCredential } from "./credentials";
import { classifyError, errorName, InfrastructureError } from "./errors";
import { startHeartbeat } from "./heartbeat";
import type { Publisher } from "./publisher";

export interface RunnerDeps {
  db: Database;
  keyring: Keyring;
  /** An Octokit authenticated as the installation (the real `GitHubAppAuth` fits), or a fake in tests. */
  github: { getClient(githubInstallationId: number): Promise<ContextClient> };
  signals: RunSignals;
  publisher: Publisher;
  logger: Logger;
  quotas: QuotaLimits;
  heartbeatIntervalMs: number;
  /** `<slug>[bot]`: how the App's own earlier comments are recognised. */
  appLogin?: string;
  now?: () => Date;
  // Seams: the real implementations by default, scripted ones in tests.
  createProvider?: typeof createProvider;
  collect?: typeof collectContext;
  review?: typeof runReview;
  validateBaseUrl?: typeof validateBaseUrl;
}

export type ProcessOutcome =
  /** No run with that id. */
  | { kind: "not_found" }
  /** Superseded, cancelled, already claimed or finished: nothing to do (a duplicate or late job). */
  | { kind: "not_queued" }
  | { kind: "finished"; status: RunStatus; run: Run }
  /** Handed back to the queue (shutdown). The job should be retried at once. */
  | { kind: "requeued" }
  /** Stopped while running; the run's final state is whatever the database already held. */
  | { kind: "stopped"; reason: StopReason };

export interface ProcessHooks {
  /** Called with every heartbeat (the per-installation slot is renewed from it). Failures are ignored. */
  onBeat?: () => Promise<void>;
}

/** Warnings are fixed sentences, but keep what a pull request can make us store bounded. */
const MAX_WARNINGS = 50;
const MAX_WARNING_CHARS = 500;

const reasons = {
  installationInactive: (status: string) =>
    `The installation is ${status}, so the pull request was not reviewed.`,
  repoGone:
    "The repository is no longer part of the installation, so the pull request was not reviewed.",
  repoDisabled: "Reviews were turned off for this repository while the run was queued.",
  noProvider:
    "No AI provider is configured for this repository. Choose a provider and model in the repository or installation settings, or ask a platform administrator to set the platform-wide AI setting.",
  noKey: (provider: string) =>
    `No API key is stored for ${provider}. Add one in the repository or installation settings, or ask a platform administrator to add a platform-wide key.`,
  unreadableKey: (provider: string) =>
    `The stored API key for ${provider} could not be read. Enter it again in the settings.`,
  baseUrl: (why: string) => `The configured base_url cannot be used: ${why}.`,
  githubMissing:
    "GitHub could not find the pull request or the repository. It may have been deleted, or the App lost access to it.",
  githubDenied:
    "GitHub refused access. Check that the App is still installed and has the permissions listed in the setup guide.",
  unexpected: "The review failed unexpectedly. The error type was written to the worker log.",
  moved: (sha: string) =>
    `The pull request moved to ${sha.slice(0, 7)} while the review was starting; a newer review replaces this one.`,
  shutdown: "The worker shut down; the review was queued again.",
  infrastructure: "A dependency was unavailable; the review was queued again.",
};

export class RunProcessor {
  readonly active = new ActiveRuns();

  constructor(private readonly deps: RunnerDeps) {}

  private now(): Date {
    return this.deps.now?.() ?? new Date();
  }

  /** Publishes `run.updated`; never throws. */
  private async emit(run: Pick<Run, "id" | "installationId" | "repoId">, status: RunStatus) {
    await this.deps.signals.publishUpdated({
      runId: run.id,
      installationId: run.installationId,
      repoId: run.repoId,
      status,
      at: this.now(),
    });
  }

  /**
   * Executes one queued run. Returns when the run reached a final state or was stopped. Throws
   * `InfrastructureError` when the job should be retried with backoff (the run has been put back in the queue,
   * or is left for the sweeper if even that failed).
   */
  async process(runId: string, hooks: ProcessHooks = {}): Promise<ProcessOutcome> {
    const { db, logger } = this.deps;
    const existing = await getRunById(db, runId);
    if (!existing) {
      logger.warn("Job for a run that does not exist", { run: runId });
      return { kind: "not_found" };
    }
    if (existing.status !== "queued") {
      logger.info("Run is no longer queued; job ignored", { run: runId, status: existing.status });
      if (existing.status === "superseded" || existing.status === "cancelled") {
        // The api stopped it before it started, so its Check Run is still `queued`: close it.
        await this.deps.publisher.conclude({
          run: existing,
          status: existing.status,
          reason: existing.statusReason ?? undefined,
        });
      }
      return { kind: "not_queued" };
    }
    // The atomic claim: of any number of workers or duplicate jobs, exactly one gets the run.
    const claimed = await claimRun(db, runId, this.now());
    if (!claimed) {
      logger.info("Run was claimed by someone else; job ignored", { run: runId });
      return { kind: "not_queued" };
    }

    let run: Run = claimed;
    const log = logger.child({
      run: run.id,
      attempt: run.attempts,
      pr: run.prNumber,
      sha: run.headSha.slice(0, 7),
    });
    log.info("Run started", { trigger: run.trigger });
    const control = this.active.register(run.id);
    const heartbeat = startHeartbeat({
      intervalMs: this.deps.heartbeatIntervalMs,
      beat: async () => {
        const alive = await touchRunHeartbeat(db, run.id, run.attempts, this.now());
        if (alive) await hooks.onBeat?.().catch(() => undefined);
        return alive;
      },
      onLost: () => {
        log.info("The run is no longer ours; stopping");
        control.abort("lost" satisfies StopReason);
      },
      onError: (err) => log.warn("Heartbeat failed", { error: errorName(err) }),
    });

    let outcome: ProcessOutcome;
    try {
      try {
        await this.emit(run, "running");
        // The Check Run may have been created just now; the rest of the run must see its id.
        const checkRunId = await this.deps.publisher.start(run);
        if (checkRunId !== undefined) run = { ...run, checkRunId };
        outcome = await this.execute(run, control.signal, log);
      } catch (err) {
        outcome = await this.handleError(run, err, control.signal, log);
      }
    } finally {
      heartbeat.stop();
      this.active.unregister(run.id);
    }
    await this.closeCheckOfStoppedRun(run, outcome);
    return outcome;
  }

  /**
   * A run that was stopped because it was superseded or cancelled has its final state written by the api, and
   * its Check Run is still `in_progress`: close it. Idempotent, and a no-op for any other outcome.
   */
  private async closeCheckOfStoppedRun(run: Run, outcome: ProcessOutcome): Promise<void> {
    if (outcome.kind !== "stopped") return;
    const final = await getRunById(this.deps.db, run.id);
    if (final && (final.status === "superseded" || final.status === "cancelled")) {
      await this.deps.publisher.conclude({
        run: { ...final, checkRunId: final.checkRunId ?? run.checkRunId },
        status: final.status,
        reason: final.statusReason ?? undefined,
      });
    }
  }

  /**
   * Writes the final state. A run that ends without a review (`checkConcluded` false) also closes its Check Run
   * `neutral` with the reason; the publisher has already closed it for a run that went through `publish`.
   */
  private async finish(
    run: Run,
    to: RunStatus,
    options: FinishOptions,
    log: Logger,
    { checkConcluded = false }: { checkConcluded?: boolean } = {},
  ): Promise<ProcessOutcome> {
    const done = await finishClaimedRun(this.deps.db, run.id, run.attempts, to, {
      ...options,
      at: this.now(),
    });
    if (!done) {
      log.info("The run is no longer ours; its final state was not written");
      return { kind: "stopped", reason: "lost" };
    }
    if (!checkConcluded) {
      await this.deps.publisher.conclude({ run: done, status: to, reason: options.reason });
    }
    await this.emit(done, to);
    log.info("Run finished", { status: to });
    return { kind: "finished", status: to, run: done };
  }

  private async execute(run: Run, signal: AbortSignal, log: Logger): Promise<ProcessOutcome> {
    const deps = this.deps;
    const { db } = deps;
    const fail = (reason: string) => this.finish(run, "failed", { reason }, log);
    const ids = [run.installationId];

    // ---- quota, checked again at start (AC-23): the enqueue check may be hours old
    const quota = await checkDailyQuota(db, run.installationId, deps.quotas, {
      since: utcDayStart(this.now()),
      excludeRunId: run.id,
    });
    if (!quota.allowed) return this.finish(run, "skipped", { reason: quota.reason }, log);

    // ---- what the run needs
    const installation = await getInstallation(db, ids, run.installationId);
    if (!installation || installation.status !== "active") {
      return this.finish(
        run,
        "skipped",
        { reason: reasons.installationInactive(installation?.status ?? "removed") },
        log,
      );
    }
    const repo = await getRepositoryById(db, run.repoId);
    if (!repo || !repo.active)
      return this.finish(run, "skipped", { reason: reasons.repoGone }, log);
    if (!repo.enabled) return this.finish(run, "skipped", { reason: reasons.repoDisabled }, log);

    const [installationSettings, repoSettings] = await Promise.all([
      getInstallationSettings(db, ids, run.installationId),
      getRepoSettings(db, ids, run.repoId),
    ]);
    // The platform-wide setting is the lowest layer: used only where nothing above it chose a provider and model.
    const platformAi = await getPlatformAiSettings(db);
    const platformModel = platformAi.activeProvider && platformAi.models[platformAi.activeProvider];
    const platformLayer =
      platformAi.activeProvider && platformModel
        ? { provider: platformAi.activeProvider, model: platformModel }
        : {};
    const dashboard = mergeDashboardLayers(
      platformLayer,
      installationSettings?.config ?? {},
      repoSettings?.config ?? {},
    );
    const effective = resolveEffectiveSettings(dashboard); // ConfigError -> failed with the problems
    if (!effective.provider || !effective.model) return fail(reasons.noProvider);

    // ---- the provider key: decrypted here and nowhere else; a missing one means no model call at all
    let credential;
    try {
      credential = await getDecryptedCredential(
        { db, keyring: deps.keyring },
        run.repoId,
        effective.provider,
      );
    } catch (err) {
      if (!(err instanceof DecryptionError)) throw err;
      return fail(reasons.unreadableKey(effective.provider));
    }
    if (!credential) return fail(reasons.noKey(effective.provider));

    if (effective.base_url) {
      const check = await (deps.validateBaseUrl ?? validateBaseUrl)(effective.base_url);
      if (!check.ok) return fail(reasons.baseUrl(check.reason));
    }
    signal.throwIfAborted();

    // ---- GitHub and the review context
    const octokit = await deps.github.getClient(installation.githubInstallationId);
    const [owner = "", name = ""] = repo.fullName.split("/");
    const context: ReviewContext = await (deps.collect ?? collectContext)({
      octokit,
      repo: { owner, repo: name },
      prNumber: run.prNumber,
      config: dashboard,
      signal,
      logger: log,
      ...(deps.appLogin ? { appLogin: deps.appLogin } : {}),
    });
    if (context.pr.headSha !== run.headSha) {
      // The review would describe a commit other than the one this run is recorded for.
      return this.finish(run, "superseded", { reason: reasons.moved(context.pr.headSha) }, log);
    }
    signal.throwIfAborted();

    // ---- the review: per-run limits go into the provider layer's governor, capped by what the quota has left
    const config = context.config;
    const limits = governorLimits(config.limits);
    const governor = new RunGovernor({
      ...limits,
      maxTotalTokens: Math.min(limits.maxTotalTokens, quota.remainingTokens),
    });
    const provider = (deps.createProvider ?? createProvider)({
      name: credential.provider,
      model: effective.model,
      apiKey: credential.apiKey,
      baseUrl: effective.base_url,
      logger: log,
    });
    const result = await (deps.review ?? runReview)(context, config, provider, signal, {
      logger: log,
      governor,
      // The Test Coverage agent reads the coverage artifact and existing tests through the same installation client.
      github: { client: octokit, repo: { owner, repo: name } },
    });
    signal.throwIfAborted();

    // ---- persist, then publish, then the final state (design §7). Each step re-checks that the run is still
    // ours, so a run superseded while the model was thinking keeps no findings and publishes nothing.
    const stillCurrent = () => touchRunHeartbeat(db, run.id, run.attempts, this.now());
    if (!(await stillCurrent())) return { kind: "stopped", reason: "lost" };

    // FR-37: what became of the previous review's findings. A failed lookup is not worth failing the review for.
    const previous = await loadPrevious(db, run, log);
    const tracking = previous
      ? trackFindings({
          previous: {
            runId: previous.runId,
            headSha: previous.headSha,
            findings: previous.findings,
          },
          current: result.findings,
          context,
          agents: result.agentRuns,
        })
      : undefined;

    const results = toRunResults(context, result, tracking);
    if (!(await saveRunResults(db, run.id, run.attempts, results))) {
      return { kind: "stopped", reason: "lost" };
    }
    const published = await deps.publisher.publish({
      run,
      context,
      result,
      stillCurrent,
      signal,
      ...(previous ? { previousFindings: previous.findings } : {}),
      ...(tracking ? { tracking } : {}),
    });
    if (published.kind === "lost") return { kind: "stopped", reason: "lost" };
    if (published.kind === "stale") {
      // Nothing was posted: a newer review for the new head replaces this one.
      return this.finish(
        run,
        "superseded",
        { reason: reasons.moved(published.currentHeadSha) },
        log,
        { checkConcluded: true },
      );
    }
    signal.throwIfAborted();

    const reason =
      result.status === "skipped"
        ? (result.reason ?? "The pull request was not reviewed.")
        : result.status === "failed"
          ? (result.reason ?? "Every review agent failed.")
          : result.reason;
    return this.finish(
      run,
      result.status,
      {
        ...(reason ? { reason } : {}),
        // Publishing errors are warnings on the run, never a silent success.
        warnings: [...results.warnings, ...published.warnings].slice(0, MAX_WARNINGS),
        usage: results.usage,
        skippedFiles: results.skippedFiles,
      },
      log,
      { checkConcluded: true },
    );
  }

  /** What an exception means for the run (see `classifyError`). */
  private async handleError(
    run: Run,
    err: unknown,
    signal: AbortSignal,
    log: Logger,
  ): Promise<ProcessOutcome> {
    const kind = signal.aborted ? "abort" : classifyError(err);
    switch (kind) {
      case "abort":
        return this.stopped(run, signal, log);

      case "infrastructure": {
        log.warn("Infrastructure error; the run goes back to the queue", {
          error: errorName(err),
        });
        try {
          const back = await requeueRun(this.deps.db, run.id, run.attempts, reasons.infrastructure);
          if (back) await this.emit(back, "queued");
        } catch {
          // The database itself is down: the sweeper requeues the run once its heartbeat expires.
        }
        throw new InfrastructureError(err);
      }

      case "config": {
        const problems = err instanceof ConfigError ? err.problems : [];
        const detail = problems.length > 0 ? `: ${problems.join("; ")}` : "";
        return this.finish(
          run,
          "failed",
          { reason: `The stored settings are invalid${detail}` },
          log,
        );
      }

      case "github_missing":
        return this.finish(run, "failed", { reason: reasons.githubMissing }, log);

      case "github_denied":
        return this.finish(run, "failed", { reason: reasons.githubDenied }, log);

      default:
        // Only the error's name is logged: its message could quote source code or a key.
        log.error("Review failed unexpectedly", { error: errorName(err) });
        return this.finish(run, "failed", { reason: reasons.unexpected }, log);
    }
  }

  private async stopped(run: Run, signal: AbortSignal, log: Logger): Promise<ProcessOutcome> {
    const reason = stopReason(signal) ?? "lost";
    log.info("Run stopped", { reason });
    if (reason === "shutdown") {
      const back = await requeueRun(this.deps.db, run.id, run.attempts, reasons.shutdown);
      if (back) await this.emit(back, "queued");
      return { kind: "requeued" };
    }
    if (reason === "superseded" || reason === "cancelled") {
      // The api writes the final state before it signals; this only covers a message that arrived first.
      const done = await finishClaimedRun(this.deps.db, run.id, run.attempts, reason, {
        reason: reason === "superseded" ? "Superseded by a newer run." : "Cancelled.",
        at: this.now(),
      });
      if (done) await this.emit(done, reason);
    }
    return { kind: "stopped", reason };
  }

  /**
   * A job ran out of retries for infrastructure errors. If the run is still queued it is failed now, with a
   * message that says so; a run that is `running` belongs to a live or recoverable worker and is left alone.
   */
  async failExhausted(runId: string, error: string): Promise<void> {
    const run = await claimRun(this.deps.db, runId, this.now());
    if (!run) return;
    await this.finish(
      run,
      "failed",
      {
        reason: `The review could not run because an infrastructure dependency kept failing (${error}). Re-run it from the dashboard or push a new commit.`,
      },
      this.deps.logger.child({ run: run.id }),
    );
  }
}

/** The previous review of the pull request, in the shape the lifecycle code compares. */
async function loadPrevious(
  db: Database,
  run: Run,
  log: Logger,
): Promise<{ runId: string; headSha: string; findings: PreviousFinding[] } | undefined> {
  try {
    const previous = await getPreviousReview(db, [run.installationId], run);
    if (!previous) return undefined;
    return {
      runId: previous.run.id,
      headSha: previous.run.headSha,
      findings: previous.findings.map((f) => ({
        fingerprint: f.fingerprint,
        agent: f.agent,
        category: f.category,
        severity: f.severity,
        title: f.title,
        ...(f.filePath !== null ? { filePath: f.filePath } : {}),
        ...(f.startLine !== null ? { startLine: f.startLine } : {}),
        posted: f.posted,
      })),
    };
  } catch (err) {
    if (classifyError(err) === "infrastructure") throw err;
    log.warn("Could not load the previous review", { error: errorName(err) });
    return undefined;
  }
}

/**
 * A model's answer is untrusted text, and what is stored here is shown by the dashboard and returned by the api:
 * secrets in known formats and the secrets this process holds are removed before they reach the database.
 */
function scrubFinding<
  T extends {
    title: string;
    evidence: string;
    impact: string;
    recommendation: string;
    suggestedTest?: string | undefined;
  },
>(finding: T): T {
  const clean = (text: string): string => redactSecrets(text).text;
  return {
    ...finding,
    title: clean(finding.title),
    evidence: clean(finding.evidence),
    impact: clean(finding.impact),
    recommendation: clean(finding.recommendation),
    ...(finding.suggestedTest !== undefined ? { suggestedTest: clean(finding.suggestedTest) } : {}),
  };
}

/** The engine's output as rows (design §5): agent runs, findings with their suppressed reasons, usage. */
export function toRunResults(
  context: ReviewContext,
  result: EngineResult,
  tracking?: FindingTracking,
): RunResults {
  const warnings = result.warnings
    .slice(0, MAX_WARNINGS)
    .map((w) => (w.length > MAX_WARNING_CHARS ? `${w.slice(0, MAX_WARNING_CHARS)}…` : w));
  return {
    agentRuns: result.agentRuns.map((a) => ({
      agent: a.agent,
      status: a.status,
      ...(a.startedAt ? { startedAt: new Date(a.startedAt) } : {}),
      durationMs: a.durationMs,
      inputTokens: a.usage.inputTokens,
      outputTokens: a.usage.outputTokens,
      retries: a.retries,
      warnings: a.warnings,
    })),
    findings: [
      ...result.findings.map(({ id, sourceCommitSha: _sha, ...rest }) => ({
        ...scrubFinding(rest),
        fingerprint: id,
      })),
      ...result.suppressed.map(({ finding: { id, sourceCommitSha: _sha, ...rest }, reason }) => ({
        ...scrubFinding(rest),
        fingerprint: id,
        suppressedReason: reason,
      })),
    ],
    warnings,
    // What the provider layer counted, so a failed agent's tokens are included.
    usage: result.governor.usage,
    skippedFiles: context.skippedFiles,
    ...(result.coverage ? { coverage: result.coverage } : {}),
    ...(tracking ? { tracking } : {}),
    ...(result.finalReview ? { finalReview: result.finalReview } : {}),
  };
}
