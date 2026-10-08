// The BullMQ side of the worker: global concurrency, a per-installation cap shared across processes, retries
// for infrastructure errors only, a dead-letter queue, `run.cancel` messages from the api, the sweeper and a
// graceful shutdown (design §7, PL-05, PL-06, PL-11).
import type { Database } from "@ai-pr-review/db";
import { getRunById } from "@ai-pr-review/db/system";
import {
  DelayedError,
  REVIEW_QUEUE,
  subscribeRunControl,
  UnrecoverableError,
  Worker,
  type BullJobQueue,
  type Job,
  type ReviewJobData,
  type SlotLimiter,
  type Subscription,
} from "@ai-pr-review/queue";
import type { Logger } from "@ai-pr-review/shared";
import type { Redis } from "ioredis";
import { classifyError, errorName, InfrastructureError } from "./errors";
import type { RunProcessor } from "./processor";
import type { Sweeper } from "./sweeper";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface ReviewWorkerOptions {
  db: Database;
  processor: RunProcessor;
  /** Also used to add dead letters. */
  queue: BullJobQueue;
  /** A Redis connection with `maxRetriesPerRequest: null`; BullMQ and the subscriber duplicate it. */
  connection: Redis;
  limiter: SlotLimiter;
  sweeper?: Sweeper;
  sweepIntervalMs?: number;
  logger: Logger;
  /** Reviews this process runs at once. */
  concurrency: number;
  /** Reviews of one installation at once, across all workers. */
  installationConcurrency: number;
  /** How long `stop` waits for running reviews before it hands them back to the queue. */
  shutdownGraceMs: number;
  /** How long a job whose installation is at its cap waits before it is looked at again. */
  busyDelayMs?: number;
  queueName?: string;
}

export class ReviewWorker {
  private worker: Worker<ReviewJobData> | undefined;
  private control: Subscription | undefined;
  private stopping = false;

  constructor(private readonly options: ReviewWorkerOptions) {}

  async start(): Promise<void> {
    const { options } = this;
    // Cancel and supersede from the api stop in-flight work (PL-06).
    this.control = await subscribeRunControl(options.connection, (message) => {
      if (options.processor.active.stop(message.runId, message.reason)) {
        options.logger.info("Stop requested for a running review", {
          run: message.runId,
          reason: message.reason,
        });
      }
    });

    this.worker = new Worker<ReviewJobData>(
      options.queueName ?? REVIEW_QUEUE,
      (job, token) => this.handle(job, token),
      {
        connection: options.connection,
        concurrency: options.concurrency,
        // Reviews take minutes; the lock is renewed automatically while the process is alive.
        lockDuration: 60_000,
        maxStalledCount: 1,
      },
    );
    this.worker.on("error", () => undefined); // connection errors: ioredis reconnects
    this.worker.on("failed", (job, err) => {
      this.onFailed(job, err).catch(() =>
        options.logger.warn("Could not record a failed job", { run: job?.data?.runId ?? "" }),
      );
    });

    options.sweeper?.start(options.sweepIntervalMs ?? 30_000);
    await this.worker.waitUntilReady();
    options.logger.info("Worker started", {
      concurrency: options.concurrency,
      perInstallation: options.installationConcurrency,
    });
  }

  /**
   * Stops taking jobs and lets running reviews finish for `shutdownGraceMs`; after that they are told to stop,
   * which puts their runs back in the queue for another worker (nothing is lost, nothing is published twice).
   */
  async stop(): Promise<void> {
    if (this.stopping) return;
    this.stopping = true;
    const { options } = this;
    options.sweeper?.stop();
    options.logger.info("Worker stopping", { running: options.processor.active.size });

    const closing = this.worker?.close() ?? Promise.resolve();
    const waited = (ms: number) =>
      Promise.race([
        closing.then(() => true),
        new Promise<boolean>((r) => setTimeout(() => r(false), ms)),
      ]);

    if (!(await waited(options.shutdownGraceMs))) {
      options.logger.warn("Reviews still running after the grace period; handing them back");
      options.processor.active.stopAll("shutdown");
      if (!(await waited(10_000))) await this.worker?.close(true);
    }
    await this.control?.close();
  }

  private async handle(job: Job<ReviewJobData>, token: string | undefined): Promise<void> {
    const { options } = this;
    const runId = job.data?.runId;
    if (typeof runId !== "string" || !UUID.test(runId)) {
      throw new UnrecoverableError("The job has no valid run id.");
    }

    const run = await getRunById(options.db, runId);
    if (!run || run.status !== "queued") {
      // Superseded, cancelled, finished or claimed: the duplicate or late job is simply done.
      options.logger.info("Job ignored; the run is not queued", {
        run: runId,
        status: run?.status ?? "missing",
      });
      return;
    }

    // Fairness: one installation cannot occupy every worker. A job that does not get a slot goes back to the
    // queue for a moment, without using up an attempt.
    const key = run.installationId;
    if (!(await options.limiter.acquire(key, runId, options.installationConcurrency))) {
      options.logger.info("Installation is at its concurrency cap; job delayed", { run: runId });
      await this.delay(job, token, options.busyDelayMs ?? 3_000);
    }

    let outcome;
    try {
      outcome = await options.processor.process(runId, {
        onBeat: () => options.limiter.renew(key, runId),
      });
    } catch (err) {
      if (err instanceof InfrastructureError || classifyError(err) === "infrastructure") {
        throw err instanceof InfrastructureError ? err : new InfrastructureError(err);
      }
      // A bug, not an outage: retrying would repeat it. The run stays `running` until the sweeper fails it.
      options.logger.error("Unexpected error while processing a run", {
        run: runId,
        error: errorName(err),
      });
      throw new UnrecoverableError("Unexpected error while processing a run.");
    } finally {
      await options.limiter.release(key, runId).catch(() => undefined);
    }

    if (outcome.kind === "requeued") await this.delay(job, token, 1_000);
  }

  /** Puts the job back in the queue for `ms` without counting an attempt. */
  private async delay(
    job: Job<ReviewJobData>,
    token: string | undefined,
    ms: number,
  ): Promise<never> {
    await job.moveToDelayed(Date.now() + ms, token);
    throw new DelayedError();
  }

  private async onFailed(job: Job<ReviewJobData> | undefined, err: Error): Promise<void> {
    if (!job?.data?.runId) return;
    const { options } = this;
    const exhausted =
      err instanceof UnrecoverableError || job.attemptsMade >= (job.opts.attempts ?? 1);
    if (!exhausted) {
      options.logger.warn("Job failed; it will be retried", {
        run: job.data.runId,
        attempt: job.attemptsMade,
        error: errorName(err instanceof InfrastructureError ? (err.original ?? err) : err),
      });
      return;
    }
    const name = errorName(err instanceof InfrastructureError ? (err.original ?? err) : err);
    options.logger.error("Job failed for good", { run: job.data.runId, error: name });
    await options.queue.deadLetter({
      runId: job.data.runId,
      error: name,
      attempts: job.attemptsMade,
    });
    // A run that never got to run is failed with a clear message; one that is running is left to the sweeper.
    await options.processor.failExhausted(job.data.runId, name);
  }
}
