import type { GitHubGateway } from "@ai-pr-review/core";
import type { Database } from "@ai-pr-review/db";
import type { JobQueue, Logger, RunTrigger } from "@ai-pr-review/shared";

/** Result of one webhook: a short outcome label (stored in `webhook_deliveries.outcome`) and the tenant. */
export interface HandlerResult {
  outcome: string;
  installationId?: string;
}

/**
 * Per-installation quota hook (PL-11, AC-23). The real quotas arrive in Phase 8; until then nothing is
 * refused. A refusal becomes a `skipped` run carrying `reason`, so users can see why.
 */
export type QuotaCheck = (input: {
  installationId: string;
  repoId: string;
  trigger: RunTrigger;
}) => Promise<{ allowed: true } | { allowed: false; reason: string }>;

export const allowAllQuota: QuotaCheck = async () => ({ allowed: true });

export interface WebhookDeps {
  db: Database;
  github: GitHubGateway;
  queue: JobQueue;
  logger: Logger;
  /** Dashboard origin, used for the Check Run's "details" link. */
  publicUrl: string;
  quota?: QuotaCheck;
}

export const ignored = (reason: string, installationId?: string): HandlerResult => ({
  outcome: `ignored:${reason}`,
  ...(installationId ? { installationId } : {}),
});
