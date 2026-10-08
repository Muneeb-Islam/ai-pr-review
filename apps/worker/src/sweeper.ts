// Stuck-run recovery (design §7, PL-05): the database is the source of truth, Redis only carries jobs. The
// sweeper finds runs whose worker died (heartbeat expired) and queued runs whose job was lost, and puts both
// back on the queue; a run that has been started too many times is failed instead.
import {
  getRunById,
  listStaleQueuedRuns,
  listStaleRunningRuns,
  recoverStaleRun,
} from "@ai-pr-review/db/system";
import type { Database } from "@ai-pr-review/db";
import type { RunSignals } from "@ai-pr-review/queue";
import type { JobQueue, Logger } from "@ai-pr-review/shared";
import type { Publisher } from "./publisher";

export interface SweeperOptions {
  db: Database;
  queue: JobQueue;
  signals: RunSignals;
  logger: Logger;
  /** Closes the Check Run of a run that is given up on (Phase 9). Without it the Check Run is left as it is. */
  publisher?: Publisher;
  /** A running run without a heartbeat for this long is presumed dead. */
  staleAfterMs: number;
  /** A queued run older than this that is still queued gets its job re-added (a no-op if the job exists). */
  queuedGraceMs: number;
  /** Starts after which a stuck run is failed instead of requeued. */
  maxRunAttempts: number;
  now?: () => Date;
}

export interface SweepResult {
  requeued: number;
  failed: number;
  /** Queued runs whose job was (re)added. */
  reenqueued: number;
}

export class Sweeper {
  private timer: ReturnType<typeof setInterval> | undefined;
  private running = false;

  constructor(private readonly options: SweeperOptions) {}

  private now(): Date {
    return this.options.now?.() ?? new Date();
  }

  /** One pass. Safe to run from every worker at once: every write is conditional on what was read. */
  async sweepOnce(): Promise<SweepResult> {
    const { db, signals, logger, staleAfterMs, queuedGraceMs, maxRunAttempts } = this.options;
    const result: SweepResult = { requeued: 0, failed: 0, reenqueued: 0 };
    const now = this.now().getTime();

    const staleBefore = new Date(now - staleAfterMs);
    for (const run of await listStaleRunningRuns(db, staleBefore)) {
      const outcome = await recoverStaleRun(db, run, staleBefore, maxRunAttempts, this.now());
      if (outcome === "not_stale") continue;
      const log = logger.child({ run: run.id, attempt: run.attempts });
      const ids = { runId: run.id, installationId: run.installationId, repoId: run.repoId };
      if (outcome === "failed") {
        result.failed++;
        log.warn("Stuck run given up on");
        await signals.publishUpdated({ ...ids, status: "failed" });
        const given = await getRunById(db, run.id);
        if (given && this.options.publisher) {
          await this.options.publisher.conclude({
            run: given,
            status: "failed",
            reason: given.statusReason ?? undefined,
          });
        }
        continue;
      }
      result.requeued++;
      log.warn("Stuck run queued again");
      await signals.publishUpdated({ ...ids, status: "queued" });
      await this.enqueue(run.id);
    }

    // Queued runs that waited longer than a job normally takes to be picked up: make sure a job exists.
    for (const run of await listStaleQueuedRuns(db, new Date(now - queuedGraceMs))) {
      if (await this.enqueue(run.id)) result.reenqueued++;
    }
    return result;
  }

  private async enqueue(runId: string): Promise<boolean> {
    try {
      await this.options.queue.enqueue(runId);
      return true;
    } catch {
      this.options.logger.warn("Could not queue a job; the next sweep tries again", { run: runId });
      return false;
    }
  }

  start(intervalMs: number): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      if (this.running) return;
      this.running = true;
      this.sweepOnce()
        .catch(() => this.options.logger.warn("Sweep failed; trying again at the next interval"))
        .finally(() => {
          this.running = false;
        });
    }, intervalMs);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }
}
