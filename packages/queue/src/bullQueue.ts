import type { JobQueue } from "@ai-pr-review/shared";
import { Queue } from "bullmq";
import type { Redis } from "ioredis";
import { DEAD_LETTER_QUEUE, REVIEW_JOB_NAME, REVIEW_QUEUE, type ReviewJobData } from "./names";

export interface BullJobQueueOptions {
  /** Attempts for infrastructure failures (Redis, database, GitHub 5xx). Review failures are never retried. */
  attempts?: number;
  /** First retry delay; doubles with every attempt. */
  backoffMs?: number;
  /** Queue name override (tests use their own queue so parallel files do not share jobs). */
  queueName?: string;
  deadLetterName?: string;
}

export const DEFAULT_JOB_ATTEMPTS = 5;
export const DEFAULT_BACKOFF_MS = 5_000;

export interface DeadLetter {
  runId: string;
  /** Error class name only: messages can quote data. */
  error: string;
  attempts: number;
  failedAt: string;
}

/**
 * `JobQueue` on BullMQ (PL-05). The job id is the run id, so enqueueing a run twice never creates two jobs.
 * A job that finished or failed earlier is replaced, which is what lets the sweeper re-queue a run from the
 * database after a crash. Redis is not a source of truth: losing it loses nothing the sweeper cannot rebuild.
 */
export class BullJobQueue implements JobQueue {
  readonly queue: Queue<ReviewJobData>;
  readonly deadLetters: Queue<DeadLetter>;
  private readonly attempts: number;
  private readonly backoffMs: number;

  constructor(connection: Redis, options: BullJobQueueOptions = {}) {
    this.attempts = options.attempts ?? DEFAULT_JOB_ATTEMPTS;
    this.backoffMs = options.backoffMs ?? DEFAULT_BACKOFF_MS;
    this.queue = new Queue<ReviewJobData>(options.queueName ?? REVIEW_QUEUE, { connection });
    this.deadLetters = new Queue<DeadLetter>(options.deadLetterName ?? DEAD_LETTER_QUEUE, {
      connection,
    });
    // Connection errors surface on the calls; an unhandled 'error' event must not crash the process.
    this.queue.on("error", () => undefined);
    this.deadLetters.on("error", () => undefined);
  }

  get maxAttempts(): number {
    return this.attempts;
  }

  /** Idempotent: a run that already has a waiting, delayed or active job keeps it. */
  async enqueue(runId: string): Promise<void> {
    const existing = await this.queue.getJob(runId);
    if (existing) {
      const state = await existing.getState();
      if (state !== "completed" && state !== "failed") return;
      await existing.remove().catch(() => undefined); // removed by a racing caller: fine
    }
    await this.queue.add(
      REVIEW_JOB_NAME,
      { runId },
      {
        jobId: runId,
        attempts: this.attempts,
        backoff: { type: "exponential", delay: this.backoffMs },
        removeOnComplete: true,
        // Kept for a while so an operator can see why; `enqueue` replaces them.
        removeOnFail: { age: 7 * 24 * 3600, count: 1000 },
      },
    );
  }

  /** Records a run whose job ran out of retries. */
  async deadLetter(entry: Omit<DeadLetter, "failedAt">): Promise<void> {
    await this.deadLetters.add(
      "dead",
      { ...entry, failedAt: new Date().toISOString() },
      { jobId: `${entry.runId}-${Date.now()}`, removeOnComplete: false, removeOnFail: false },
    );
  }

  async counts(): Promise<Record<string, number>> {
    return this.queue.getJobCounts("waiting", "active", "delayed", "failed");
  }

  /** Jobs that ran out of retries and wait for an operator (the dead-letter queue is never consumed). */
  async deadLetterCount(): Promise<number> {
    const counts = await this.deadLetters.getJobCounts("waiting", "delayed");
    return (counts["waiting"] ?? 0) + (counts["delayed"] ?? 0);
  }

  async close(): Promise<void> {
    await Promise.all([this.queue.close(), this.deadLetters.close()]);
  }
}
