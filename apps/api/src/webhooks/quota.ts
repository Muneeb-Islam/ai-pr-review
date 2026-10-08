// The quota hook of `requestRun` (PL-05, PL-11, AC-23): a run that would exceed the installation's daily quota, or
// join a queue that is full, is recorded as `skipped` with the reason instead of being queued. The worker checks the
// daily quota again when the run starts (the enqueue check may be hours old).
import type { Database } from "@ai-pr-review/db";
import { checkDailyQuota, getQueueDepth } from "@ai-pr-review/db/system";
import {
  evaluateQueueDepth,
  utcDayStart,
  type QueueLimits,
  type QuotaLimits,
} from "@ai-pr-review/shared";
import type { QuotaCheck } from "./types";

export interface QuotaCheckOptions {
  db: Database;
  quotas: QuotaLimits;
  queue: QueueLimits;
  now?: () => Date;
}

export function createQuotaCheck(options: QuotaCheckOptions): QuotaCheck {
  const { db, quotas, queue } = options;
  return async ({ installationId, db: inTransaction }) => {
    const reader = inTransaction ?? db;
    const now = options.now?.() ?? new Date();
    const daily = await checkDailyQuota(reader, installationId, quotas, {
      since: utcDayStart(now),
    });
    if (!daily.allowed) return { allowed: false, reason: daily.reason };
    const depth = await getQueueDepth(reader, installationId);
    return evaluateQueueDepth(depth, queue);
  };
}
