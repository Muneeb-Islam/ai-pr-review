import type { GitHubGateway } from "@ai-pr-review/core";
import type { Database, Run } from "@ai-pr-review/db";
import type { RunSignals } from "@ai-pr-review/queue";
import type { JobQueue, Logger, RunTrigger } from "@ai-pr-review/shared";

/** Result of one webhook: a short outcome label (stored in `webhook_deliveries.outcome`) and the tenant. */
export interface HandlerResult {
  outcome: string;
  installationId?: string;
  /** The run the event led to (queued, skipped or the identical one that already existed), when there is one. */
  run?: Run;
}

/**
 * Per-installation quota hook (PL-11, AC-23). The real quotas arrive in Phase 8; until then nothing is
 * refused. A refusal becomes a `skipped` run carrying `reason`, so users can see why.
 */
export type QuotaCheck = (input: {
  installationId: string;
  repoId: string;
  trigger: RunTrigger;
  /** The transaction the run is created in, so the check and the creation are one step (Phase 15). */
  db?: Database;
}) => Promise<{ allowed: true } | { allowed: false; reason: string }>;

export const allowAllQuota: QuotaCheck = async () => ({ allowed: true });

export interface WebhookDeps {
  db: Database;
  github: GitHubGateway;
  queue: JobQueue;
  /** Announces run state changes to the dashboard (SSE) and cancels superseded runs. Tests of other things omit it. */
  signals?: RunSignals;
  logger: Logger;
  /** Dashboard origin, used for the Check Run's "details" link. */
  publicUrl: string;
  quota?: QuotaCheck;
}

export const ignored = (reason: string, installationId?: string): HandlerResult => ({
  outcome: `ignored:${reason}`,
  ...(installationId ? { installationId } : {}),
});
