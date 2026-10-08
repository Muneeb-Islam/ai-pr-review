// Publishing a run's review to GitHub (Phase 9, design §7 and §12): the inline review, the summary comment and
// the Check Run, with the results recorded in the database. The rendering and the GitHub calls live in
// `@ai-pr-review/core`; this module adds the database around them.
import {
  checkConclusion,
  agentStates,
  completeCheckRun,
  classifyGitHubError,
  enforcementPolicy,
  publishReview,
  renderCheckOutput,
  startCheckRun,
  type CheckTarget,
  type ContextClient,
  type EngineResult,
  type PreviousFinding,
  type PublishReport,
  type ReviewContext,
} from "@ai-pr-review/core";
import {
  getInstallation,
  listPostedFingerprints,
  markRunFindingsPosted,
  recordPostedComments,
  suppressRunFindings,
  updateRunDetails,
  type Database,
  type Run,
} from "@ai-pr-review/db";
import { getRepositoryById } from "@ai-pr-review/db/system";
import type { FindingTracking, Logger, RunStatus } from "@ai-pr-review/shared";

export interface PublishInput {
  run: Run;
  context: ReviewContext;
  result: EngineResult;
  /** True while the run is still ours; the publisher checks it again before every write to GitHub. */
  stillCurrent: () => Promise<boolean>;
  signal: AbortSignal;
  /** The previous review's findings, so one that persists is not posted again (FR-36). */
  previousFindings?: readonly PreviousFinding[];
  /** What became of the previous review's findings, for the summary (FR-37). */
  tracking?: FindingTracking;
}

export type PublishOutcome =
  /** The review is on GitHub as far as GitHub allowed. `warnings` say what it refused (never fatal). */
  | { kind: "published"; warnings: string[]; degraded: boolean }
  /** The pull request moved to another commit while the review ran; nothing was posted (design §12). */
  | { kind: "stale"; currentHeadSha: string }
  /** The run stopped being ours; nothing more was posted. */
  | { kind: "lost" };

export interface ConcludeInput {
  run: Run;
  /** The run's final status; the Check Run is completed `neutral` with this reason. */
  status: RunStatus;
  reason?: string | undefined;
}

/**
 * Everything the worker does on GitHub for a run. The run's results are already persisted when `publish` is
 * called, and nothing is published for a run that was superseded or cancelled (the processor does not call it
 * then). None of the methods throws for a GitHub error: a 403, a 422 or an outage becomes a warning, so the
 * review is never lost to the publisher. Only an abort propagates.
 */
export interface Publisher {
  /**
   * The Check Run goes `in_progress` (created now if it could not be created when the run was queued).
   * Returns the Check Run's id, or undefined when there is none.
   */
  start(run: Run): Promise<number | undefined>;
  /** The inline review, the summary and the Check Run conclusion. */
  publish(input: PublishInput): Promise<PublishOutcome>;
  /** The run ended without a review (failed early, skipped, superseded, cancelled): close the Check Run. */
  conclude(input: ConcludeInput): Promise<void>;
}

/** For tests of the lifecycle alone: nothing reaches GitHub. */
export class NoopPublisher implements Publisher {
  async start(): Promise<number | undefined> {
    return undefined;
  }
  async publish(): Promise<PublishOutcome> {
    return { kind: "published", warnings: [], degraded: false };
  }
  async conclude(): Promise<void> {}
}

export interface GitHubPublisherDeps {
  db: Database;
  /** An Octokit authenticated as the installation (the real `GitHubAppAuth` fits), or a fake in tests. */
  github: { getClient(githubInstallationId: number): Promise<ContextClient> };
  /** Base URL of the dashboard, for the link to the run. */
  publicUrl: string;
  logger: Logger;
  /** `<slug>[bot]`: how the App's own summary comment is recognised before it is edited. */
  appLogin?: string | undefined;
  now?: () => Date;
}

const WARNINGS = {
  checkDenied:
    "GitHub refused to update the Check Run: the App needs the Checks: write permission.",
  checkUnavailable: "GitHub was unavailable, so the Check Run could not be updated.",
};

export class GitHubPublisher implements Publisher {
  constructor(private readonly deps: GitHubPublisherDeps) {}

  private now(): Date {
    return this.deps.now?.() ?? new Date();
  }

  private dashboardUrl(run: Run): string {
    return new URL(`/runs/${run.id}`, this.deps.publicUrl).toString();
  }

  private checkTarget(run: Run): CheckTarget {
    return {
      checkRunId: run.checkRunId,
      headSha: run.headSha,
      externalId: run.id,
      detailsUrl: this.dashboardUrl(run),
    };
  }

  /** The installation's client and the repository of a run, or undefined if either is gone. */
  private async target(run: Run): Promise<
    | {
        client: ContextClient;
        repo: { owner: string; repo: string };
      }
    | undefined
  > {
    const { db, github } = this.deps;
    const installation = await getInstallation(db, [run.installationId], run.installationId);
    const repo = await getRepositoryById(db, run.repoId);
    if (!installation || !repo) return undefined;
    const [owner = "", name = ""] = repo.fullName.split("/");
    return {
      client: await github.getClient(installation.githubInstallationId),
      repo: { owner, repo: name },
    };
  }

  private async rememberCheckRun(run: Run, id: number): Promise<void> {
    if (id !== run.checkRunId) {
      await updateRunDetails(this.deps.db, run.installationId, run.id, { checkRunId: id });
    }
  }

  async start(run: Run): Promise<number | undefined> {
    const log = this.deps.logger.child({ run: run.id });
    try {
      const target = await this.target(run);
      if (!target) return undefined;
      const id = await startCheckRun(target.client, target.repo, this.checkTarget(run), this.now());
      await this.rememberCheckRun(run, id);
      return id;
    } catch (err) {
      // The review matters more than the check; the conclusion step tries again.
      log.warn("Could not mark the Check Run in progress", { failure: classifyGitHubError(err) });
      return undefined;
    }
  }

  async conclude({ run, status, reason }: ConcludeInput): Promise<void> {
    const log = this.deps.logger.child({ run: run.id });
    // A superseded or cancelled run never had anything to show; do not create a Check Run only to close it.
    if (!run.checkRunId && (status === "superseded" || status === "cancelled")) return;
    try {
      const target = await this.target(run);
      if (!target) return;
      const outcome = {
        status,
        reason,
        findings: [],
        warnings: [],
        degraded: false,
        headSha: run.headSha,
        dashboardUrl: this.dashboardUrl(run),
      };
      const id = await completeCheckRun(target.client, target.repo, this.checkTarget(run), {
        conclusion: checkConclusion(outcome),
        output: renderCheckOutput(outcome),
        now: this.now(),
      });
      await this.rememberCheckRun(run, id);
    } catch (err) {
      log.warn("Could not complete the Check Run", { failure: classifyGitHubError(err) });
    }
  }

  async publish(input: PublishInput): Promise<PublishOutcome> {
    const { run, context, result, signal } = input;
    const { db } = this.deps;
    const log = this.deps.logger.child({ run: run.id });
    const target = await this.target(run);
    if (!target) {
      return {
        kind: "published",
        warnings: ["The repository is no longer available, so nothing was posted to GitHub."],
        degraded: true,
      };
    }

    const posted = await listPostedFingerprints(
      db,
      [run.installationId],
      run.repoId,
      context.pr.headSha,
    );
    const report: PublishReport = await publishReview({
      client: target.client,
      repo: target.repo,
      context,
      result,
      dashboardUrl: this.dashboardUrl(run),
      appLogin: this.deps.appLogin,
      postedFingerprints: new Set(posted),
      previousPosted: input.previousFindings,
      tracking: input.tracking,
      finalReview: result.finalReview,
      stillCurrent: input.stillCurrent,
      signal,
      logger: log,
    });

    if (report.kind === "lost") return report;
    if (report.kind === "stale") {
      await this.conclude({
        run,
        status: "superseded",
        reason: `The pull request moved to ${report.currentHeadSha.slice(0, 7)} while the review was running.`,
      });
      return report;
    }

    // What GitHub now holds, recorded in the database (design §5): comment ids, the summary, posted findings.
    const headSha = context.pr.headSha;
    await recordPostedComments(db, run.installationId, run.id, [
      ...report.inline.flatMap((p) =>
        p.githubId === undefined
          ? []
          : [
              {
                kind: "review_comment" as const,
                githubId: p.githubId,
                fingerprint: p.finding.id,
                headSha,
              },
            ],
      ),
      ...(report.summary
        ? [{ kind: "summary" as const, githubId: report.summary.id, headSha }]
        : []),
    ]);
    // `posted` means "an inline comment for it is on the pull request": the findings posted now, and the ones an
    // earlier comment already covers (so a later run still recognises them as posted).
    await markRunFindingsPosted(db, run.installationId, run.id, [
      ...report.inline.map((p) => ({ agent: p.finding.agent, fingerprint: p.finding.id })),
      ...report.alreadyPosted.map((f) => ({ agent: f.agent, fingerprint: f.id })),
    ]);
    await suppressRunFindings(
      db,
      run.installationId,
      run.id,
      report.invalidPosition.map((f) => ({ agent: f.agent, fingerprint: f.id })),
      "invalid_line",
    );
    if (report.summary) {
      await updateRunDetails(db, run.installationId, run.id, {
        summaryCommentId: report.summary.id,
      });
    }

    // The Check Run last, once its title and summary can say what really happened.
    const warnings = [...report.warnings];
    let degraded = report.degraded;
    const droppedIds = new Set(report.invalidPosition.map((f) => f.id));
    try {
      const outcome = {
        status: result.status,
        reason: result.reason,
        findings: result.findings.filter((f) => !droppedIds.has(f.id)),
        coverage: result.coverage,
        securityState: agentStates(context.config, result.agentRuns).find(
          (a) => a.agent === "security",
        )?.state,
        warnings: [...result.warnings, ...warnings],
        degraded,
        policy: enforcementPolicy(context.config.review),
        headSha,
        dashboardUrl: this.dashboardUrl(run),
      };
      const id = await completeCheckRun(
        target.client,
        target.repo,
        this.checkTarget(run),
        {
          conclusion: checkConclusion(outcome),
          output: renderCheckOutput(outcome),
          now: this.now(),
        },
        signal,
      );
      await this.rememberCheckRun(run, id);
    } catch (err) {
      if (signal.aborted) throw err;
      const failure = classifyGitHubError(err);
      log.warn("Could not complete the Check Run", { failure });
      warnings.push(failure === "denied" ? WARNINGS.checkDenied : WARNINGS.checkUnavailable);
      degraded = true;
    }
    return { kind: "published", warnings, degraded };
  }
}
