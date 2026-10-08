// Installation lifecycle and data retention beyond runs (Phase 15, PL-08, AC-20, AC-22): what happens to an
// installation's data when the App is uninstalled or suspended, the scheduled purge at the end of retention, and
// the clean-up of the platform's own bookkeeping tables. System module: unscoped by design.
import { and, eq, inArray, lt, sql } from "drizzle-orm";
import type { Database } from "../client";
import { InvalidInputError } from "../errors";
import { ACTIVE_STATUSES } from "../lifecycle";
import {
  auditLog,
  installations,
  providerCredentials,
  reviewRuns,
  userInstallations,
  userRepositories,
  webhookDeliveries,
} from "../schema";
import { isUuid } from "../scope";
import { setAllRepositoriesActive } from "../tenant/repos";
import type { Run } from "../types";
import { setInstallationStatus } from "./installations";

const DAY_MS = 24 * 60 * 60 * 1000;

const requireDays = (days: number): void => {
  if (!Number.isFinite(days) || days <= 0)
    throw new InvalidInputError("days must be a positive number");
};

/**
 * Stops every queued or running run of an installation (suspend and uninstall). One statement, so a worker that
 * is executing one loses its fence (`status` is no longer `running`) at its next write, exactly as for a user's
 * cancel. Returns the runs as they now are, so the caller can announce them and tell workers to stop.
 */
export async function cancelActiveRunsOfInstallation(
  db: Database,
  installationId: string,
  reason: string,
  now: Date = new Date(),
): Promise<Run[]> {
  if (!isUuid(installationId)) return [];
  return db
    .update(reviewRuns)
    .set({ status: "cancelled", statusReason: reason, finishedAt: now })
    .where(
      and(
        eq(reviewRuns.installationId, installationId),
        inArray(reviewRuns.status, [...ACTIVE_STATUSES]),
      ),
    )
    .returning();
}

/**
 * Deletes every stored provider key of an installation. An uninstalled App has no use for them, and a secret
 * should not outlive its purpose by the length of the retention window. Returns how many keys were deleted.
 */
export async function deleteInstallationCredentials(
  db: Database,
  installationId: string,
): Promise<number> {
  if (!isUuid(installationId)) return 0;
  const rows = await db
    .delete(providerCredentials)
    .where(eq(providerCredentials.installationId, installationId))
    .returning({ id: providerCredentials.id });
  return rows.length;
}

/**
 * Removes the access caches of an installation (who may see it). They are rebuilt from GitHub at the next sign-in
 * if the App is installed again; until then nobody has access, even through a session that is still alive.
 */
export async function deleteInstallationAccess(
  db: Database,
  installationId: string,
): Promise<number> {
  if (!isUuid(installationId)) return 0;
  const [users, repos] = await Promise.all([
    db
      .delete(userInstallations)
      .where(eq(userInstallations.installationId, installationId))
      .returning({ userId: userInstallations.userId }),
    db
      .delete(userRepositories)
      .where(eq(userRepositories.installationId, installationId))
      .returning({ userId: userRepositories.userId }),
  ]);
  return users.length + repos.length;
}

/**
 * Deletes installations that were uninstalled more than `days` days ago, with everything they own (repositories,
 * settings, runs, findings, feedback, comments, audit entries) through ON DELETE CASCADE. One conditional
 * statement: several workers, or a repeat after a crash, cannot do harm. Suspended installations are kept
 * (suspension is reversible). Returns the number of installations purged.
 */
export async function purgeDeletedInstallations(
  db: Database,
  days: number,
  now: Date = new Date(),
): Promise<number> {
  requireDays(days);
  const cutoff = new Date(now.getTime() - days * DAY_MS);
  const rows = await db
    .delete(installations)
    .where(and(eq(installations.status, "deleted"), lt(installations.statusChangedAt, cutoff)))
    .returning({ id: installations.id });
  return rows.length;
}

/** Audit entries are kept for their own period (`AUDIT_RETENTION_DAYS`), longer than the runs they describe. */
export async function deleteAuditOlderThan(
  db: Database,
  days: number,
  now: Date = new Date(),
): Promise<number> {
  requireDays(days);
  const cutoff = new Date(now.getTime() - days * DAY_MS);
  const rows = await db
    .delete(auditLog)
    .where(lt(auditLog.at, cutoff))
    .returning({ id: auditLog.id });
  return rows.length;
}

/** Delivery records exist for idempotency; GitHub redelivers within days, so old ones carry no weight. */
export async function deleteWebhookDeliveriesOlderThan(
  db: Database,
  days: number,
  now: Date = new Date(),
): Promise<number> {
  requireDays(days);
  const cutoff = new Date(now.getTime() - days * DAY_MS);
  const rows = await db
    .delete(webhookDeliveries)
    .where(lt(webhookDeliveries.receivedAt, cutoff))
    .returning({ id: webhookDeliveries.deliveryId });
  return rows.length;
}

/**
 * Drops cached GitHub access that has not been refreshed since `olderThan`. The caches are rebuilt at sign-in,
 * and no session outlives `SESSION_ABSOLUTE_TIMEOUT_HOURS`, so rows older than that are dead weight (and stale
 * claims about who could see what).
 */
export async function deleteStaleAccessCache(db: Database, olderThan: Date): Promise<number> {
  const [users, repos] = await Promise.all([
    db
      .delete(userInstallations)
      .where(lt(userInstallations.refreshedAt, olderThan))
      .returning({ userId: userInstallations.userId }),
    db
      .delete(userRepositories)
      .where(lt(userRepositories.refreshedAt, olderThan))
      .returning({ userId: userRepositories.userId }),
  ]);
  return users.length + repos.length;
}

/** Active installations, for the scheduled reconciliation with GitHub. */
export async function listActiveInstallations(
  db: Database,
): Promise<Array<{ id: string; githubInstallationId: number; accountLogin: string }>> {
  return db
    .select({
      id: installations.id,
      githubInstallationId: installations.githubInstallationId,
      accountLogin: installations.accountLogin,
    })
    .from(installations)
    .where(eq(installations.status, "active"))
    .orderBy(sql`${installations.id}`);
}

export interface Deactivation {
  installationId: string;
  /** Runs that were queued or running and are now cancelled, for the caller to announce. */
  stopped: Run[];
  /** Repositories deactivated (uninstall only). */
  repositories: number;
  /** Provider keys deleted (uninstall only). */
  keys: number;
}

/**
 * The App was uninstalled (`deleted`) or suspended (`suspended`) on GitHub. In this order, so that nothing new can
 * start while the rest happens: the status changes (the dashboard hides the data and no webhook creates a run), what
 * was waiting or running is cancelled with the reason, and on uninstall the repositories are deactivated and the
 * provider keys and the access caches are deleted. History stays until retention ends (`purgeDeletedInstallations`);
 * a suspended installation keeps its keys and access because suspension is reversible. Every step is idempotent, so
 * a repeated event or a crash half-way is healed by running it again. Returns undefined for an unknown installation.
 */
export async function deactivateInstallation(
  db: Database,
  githubInstallationId: number,
  mode: "deleted" | "suspended",
  reason: string,
  now: Date = new Date(),
): Promise<Deactivation | undefined> {
  const installation = await setInstallationStatus(db, githubInstallationId, mode);
  if (!installation) return undefined;
  const stopped = await cancelActiveRunsOfInstallation(db, installation.id, reason, now);
  if (mode === "suspended")
    return { installationId: installation.id, stopped, repositories: 0, keys: 0 };

  const repositories = await setAllRepositoriesActive(db, installation.id, false);
  const keys = await deleteInstallationCredentials(db, installation.id);
  await deleteInstallationAccess(db, installation.id);
  return { installationId: installation.id, stopped, repositories, keys };
}
