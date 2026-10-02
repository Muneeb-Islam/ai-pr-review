import { and, lt, notInArray } from "drizzle-orm";
import type { Database } from "../client";
import { InvalidInputError } from "../errors";
import { ACTIVE_STATUSES } from "../lifecycle";
import { reviewRuns } from "../schema";

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Retention (PL-08, AC-20): deletes finished runs queued more than `days` days ago. Agent runs, findings,
 * posted comments and finding feedback go with them through ON DELETE CASCADE; repositories,
 * installations, settings, credentials and the audit log are untouched. Active (queued or running) runs
 * are never deleted, so a live run cannot disappear underneath the worker; the stuck-run sweeper owns
 * those.
 *
 * Returns the number of runs deleted.
 */
export async function deleteRunsOlderThan(
  db: Database,
  days: number,
  now: Date = new Date(),
): Promise<number> {
  if (!Number.isFinite(days) || days <= 0) {
    throw new InvalidInputError("days must be a positive number");
  }
  const cutoff = new Date(now.getTime() - days * DAY_MS);
  const rows = await db
    .delete(reviewRuns)
    .where(
      and(lt(reviewRuns.queuedAt, cutoff), notInArray(reviewRuns.status, [...ACTIVE_STATUSES])),
    )
    .returning({ id: reviewRuns.id });
  return rows.length;
}
