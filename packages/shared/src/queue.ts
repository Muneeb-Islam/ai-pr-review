/**
 * What the api needs from the job queue: hand a run to the worker. The job payload is only the run id
 * (design §7); the worker loads everything else from the database. The BullMQ implementation arrives
 * in Phase 8; until then the api uses a logging or in-memory queue.
 */
export interface JobQueue {
  enqueue(runId: string): Promise<void>;
}

/** Records enqueued run ids in memory. For tests and for running the api before the worker exists. */
export class InMemoryJobQueue implements JobQueue {
  readonly jobs: string[] = [];

  async enqueue(runId: string): Promise<void> {
    this.jobs.push(runId);
  }
}
