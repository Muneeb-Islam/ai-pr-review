// Per-installation daily quotas (PL-11, AC-23). Pure rules; the usage numbers come from the database
// (`getDailyUsage` in packages/db) and the limits from the server environment.

export interface QuotaLimits {
  runsPerDay: number;
  tokensPerDay: number;
}

/** What an installation has used since the start of the current UTC day. */
export interface DailyUsage {
  /** Runs queued today that were not stopped by a guard (skipped runs cost nothing and do not count). */
  runs: number;
  /** Input plus output tokens reported by today's runs. */
  tokens: number;
}

/** Machine-readable prefix of the `status_reason` of a run that a quota stopped. */
export const QUOTA_EXCEEDED = "quota_exceeded";

export type QuotaDecision =
  | { allowed: true; remainingRuns: number; remainingTokens: number }
  | { allowed: false; reason: string };

/** The quota day is the UTC calendar day: it resets at 00:00 UTC for everyone. */
export function utcDayStart(now: Date = new Date()): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
}

/**
 * Whether one more run may start. `usage.runs` must not include the run being decided on. Tokens are only known
 * once a run reports them, so the token limit stops the first run after it is spent; the per-run
 * `max_total_tokens` bounds the overshoot, and `remainingTokens` lets the worker cap a run to what is left.
 */
export function evaluateQuota(usage: DailyUsage, limits: QuotaLimits): QuotaDecision {
  if (usage.runs >= limits.runsPerDay) {
    return {
      allowed: false,
      reason: `${QUOTA_EXCEEDED}: the installation's daily limit of ${limits.runsPerDay} runs is used up; it resets at 00:00 UTC.`,
    };
  }
  if (usage.tokens >= limits.tokensPerDay) {
    return {
      allowed: false,
      reason: `${QUOTA_EXCEEDED}: the installation's daily limit of ${limits.tokensPerDay} tokens is used up; it resets at 00:00 UTC.`,
    };
  }
  return {
    allowed: true,
    remainingRuns: limits.runsPerDay - usage.runs,
    remainingTokens: limits.tokensPerDay - usage.tokens,
  };
}

// ---------- queue depth (PL-05, PL-11, AC-23) ----------

/** Machine-readable prefix of the `status_reason` of a run that the queue limits stopped. */
export const QUEUE_LIMIT = "queue_limit";

export interface QueueLimits {
  /** Runs one installation may have queued at once. */
  perInstallation: number;
  /** Runs queued across all installations. */
  global: number;
}

/** Runs waiting (`queued`) right now. `installation` and `global` both include every queued run. */
export interface QueueDepth {
  installation: number;
  global: number;
}

export type QueueDecision = { allowed: true } | { allowed: false; reason: string };

/**
 * Whether one more run may join the queue. Daily quotas bound cost; this bounds backlog, so one installation
 * (a burst of pushes, a flood of fork PRs) cannot fill the queue and starve the others.
 */
export function evaluateQueueDepth(depth: QueueDepth, limits: QueueLimits): QueueDecision {
  if (depth.installation >= limits.perInstallation) {
    return {
      allowed: false,
      reason: `${QUEUE_LIMIT}: ${limits.perInstallation} reviews of this installation are already waiting; this one was not queued. Push again or re-run when the queue has drained.`,
    };
  }
  if (depth.global >= limits.global) {
    return {
      allowed: false,
      reason: `${QUEUE_LIMIT}: the platform's review queue is full; this review was not queued. Push again or re-run in a few minutes.`,
    };
  }
  return { allowed: true };
}
