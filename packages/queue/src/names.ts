/** BullMQ queue of review jobs. The payload is only `{ runId }` (design §7). */
export const REVIEW_QUEUE = "review-runs";
/** Jobs that ran out of retries land here with the run id and an error name, for an operator to look at. */
export const DEAD_LETTER_QUEUE = "review-runs-dead";
export const REVIEW_JOB_NAME = "review";

/** Redis pub/sub channel: the worker and api announce every run state change (SSE fan-out, Phase 10). */
export const RUN_EVENTS_CHANNEL = "ai-pr-review:run-events";
/** Redis pub/sub channel: the api tells workers to stop a run (supersede, cancel). */
export const RUN_CONTROL_CHANNEL = "ai-pr-review:run-control";

export interface ReviewJobData {
  runId: string;
}
