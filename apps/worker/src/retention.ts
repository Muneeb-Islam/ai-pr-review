// Retention cleanup (PL-08, AC-20, AC-22): finished runs older than the retention window are deleted with their agent
// runs, findings, posted-comment records and feedback; installations uninstalled longer ago than the window are purged
// with everything they own; the audit log, the webhook delivery records and stale access caches are trimmed on their own
// schedules. Every worker runs it on a timer; each delete is one conditional statement, so several workers (or a repeat
// after a crash) cannot do harm. Active runs are never touched (the stuck-run sweeper owns those).
import type { Database } from "@ai-pr-review/db";
import {
  deleteAuditOlderThan,
  deleteRunsOlderThan,
  deleteStaleAccessCache,
  deleteWebhookDeliveriesOlderThan,
  purgeDeletedInstallations,
} from "@ai-pr-review/db/system";
import type { Logger } from "@ai-pr-review/shared";

export interface RetentionJobOptions {
  db: Database;
  logger: Logger;
  /** Finished runs queued longer ago than this many days are deleted (`RETENTION_DAYS`); uninstalled installations too. */
  days: number;
  /** Audit entries older than this are deleted (`AUDIT_RETENTION_DAYS`). Skipped when unset. */
  auditDays?: number;
  /** Webhook delivery records older than this are deleted (`WEBHOOK_DELIVERY_RETENTION_DAYS`). Skipped when unset. */
  webhookDays?: number;
  /** Cached GitHub access not refreshed for this long is deleted. Skipped when unset. */
  accessCacheMaxAgeMs?: number;
  now?: () => Date;
}

export interface RetentionResult {
  runs: number;
  installations: number;
  audit: number;
  webhooks: number;
  accessCache: number;
}

export class RetentionJob {
  private timer: ReturnType<typeof setInterval> | undefined;
  private running = false;

  constructor(private readonly options: RetentionJobOptions) {}

  /** One pass over everything. Each step is independent: a failing one is reported after the others have run. */
  async runAll(): Promise<RetentionResult> {
    const { db, logger, days, auditDays, webhookDays, accessCacheMaxAgeMs } = this.options;
    const now = this.options.now?.() ?? new Date();
    const result: RetentionResult = {
      runs: 0,
      installations: 0,
      audit: 0,
      webhooks: 0,
      accessCache: 0,
    };
    const failures: string[] = [];
    const step = async (name: string, fn: () => Promise<number>): Promise<number> => {
      try {
        return await fn();
      } catch {
        failures.push(name);
        return 0;
      }
    };

    result.runs = await step("runs", () => deleteRunsOlderThan(db, days, now));
    result.installations = await step("installations", () =>
      purgeDeletedInstallations(db, days, now),
    );
    if (auditDays !== undefined) {
      result.audit = await step("audit", () => deleteAuditOlderThan(db, auditDays, now));
    }
    if (webhookDays !== undefined) {
      result.webhooks = await step("webhooks", () =>
        deleteWebhookDeliveriesOlderThan(db, webhookDays, now),
      );
    }
    if (accessCacheMaxAgeMs !== undefined) {
      result.accessCache = await step("access cache", () =>
        deleteStaleAccessCache(db, new Date(now.getTime() - accessCacheMaxAgeMs)),
      );
    }

    if (result.runs > 0)
      logger.info("Retention cleanup removed old runs", { runs: result.runs, days });
    if (result.installations > 0) {
      logger.info("Retention cleanup purged uninstalled installations", {
        installations: result.installations,
        days,
      });
    }
    if (result.audit + result.webhooks + result.accessCache > 0) {
      logger.info("Retention cleanup trimmed bookkeeping", {
        audit: result.audit,
        webhooks: result.webhooks,
        accessCache: result.accessCache,
      });
    }
    // Names only: an error message from the driver can quote data.
    if (failures.length > 0) throw new Error(`Retention steps failed: ${failures.join(", ")}`);
    return result;
  }

  /** One pass. Returns how many runs were deleted. */
  async runOnce(): Promise<number> {
    return (await this.runAll()).runs;
  }

  /** Runs once now and then every `intervalMs`. A pass that fails is logged and tried again at the next one. */
  start(intervalMs: number): void {
    if (this.timer) return;
    const tick = () => {
      if (this.running) return;
      this.running = true;
      this.runOnce()
        .catch(() => this.options.logger.warn("Retention cleanup failed; trying again later"))
        .finally(() => {
          this.running = false;
        });
    };
    tick();
    this.timer = setInterval(tick, intervalMs);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }
}
