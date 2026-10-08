import { and, desc, eq } from "drizzle-orm";
import type { Database } from "../client";
import { NotFoundError } from "../errors";
import { afterCursor, clampLimit, toPage, type Page } from "../pagination";
import { auditLog, users } from "../schema";
import { inInstallations, isUuid, type InstallationIds } from "../scope";
import type { AuditEntry } from "../types";

export interface NewAuditEntry {
  userId?: string;
  /** e.g. `settings.update`, `credential.put`, `run.rerun`, `run.cancel` (PL-15). */
  action: string;
  /** What the action touched, e.g. `repo:<uuid>` or `run:<uuid>`. */
  target: string;
  /** Context for the entry. Must not contain secrets (provider keys, tokens). */
  metadata?: Record<string, unknown>;
  at?: Date;
}

/** The audit log is append-only: there is deliberately no update or delete function. */
export async function appendAuditLog(
  db: Database,
  installationId: string,
  input: NewAuditEntry,
): Promise<AuditEntry> {
  if (!isUuid(installationId)) throw new NotFoundError("Installation");
  const [row] = await db
    .insert(auditLog)
    .values({
      installationId,
      userId: input.userId ?? null,
      action: input.action,
      target: input.target,
      metadata: input.metadata ?? {},
      ...(input.at ? { at: input.at } : {}),
    })
    .returning();
  return row!;
}

export async function listAuditLog(
  db: Database,
  installationIds: InstallationIds,
  filters: { installationId?: string; action?: string; cursor?: string; limit?: number } = {},
): Promise<Page<AuditEntry>> {
  const limit = clampLimit(filters.limit);
  if (filters.installationId !== undefined && !isUuid(filters.installationId)) {
    return { items: [], nextCursor: null };
  }
  const rows = await db
    .select()
    .from(auditLog)
    .where(
      and(
        inInstallations(auditLog.installationId, installationIds),
        filters.installationId ? eq(auditLog.installationId, filters.installationId) : undefined,
        filters.action ? eq(auditLog.action, filters.action) : undefined,
        filters.cursor ? afterCursor(auditLog.at, auditLog.id, filters.cursor) : undefined,
      ),
    )
    .orderBy(desc(auditLog.at), desc(auditLog.id))
    .limit(limit + 1);
  return toPage(rows, limit, (r) => ({ at: r.at, id: r.id }));
}

/** An audit entry with the GitHub login of the person who did it (null when that account is gone). */
export interface AuditEntryWithUser {
  entry: AuditEntry;
  userLogin: string | null;
}

/** The audit view (PL-15): entries of one installation, newest first, with who did what. */
export async function listAuditEntries(
  db: Database,
  installationIds: InstallationIds,
  filters: { installationId: string; action?: string; cursor?: string; limit?: number },
): Promise<Page<AuditEntryWithUser>> {
  const limit = clampLimit(filters.limit);
  if (!isUuid(filters.installationId)) return { items: [], nextCursor: null };
  const rows = await db
    .select({ entry: auditLog, userLogin: users.login })
    .from(auditLog)
    .leftJoin(users, eq(users.id, auditLog.userId))
    .where(
      and(
        inInstallations(auditLog.installationId, installationIds),
        eq(auditLog.installationId, filters.installationId),
        filters.action ? eq(auditLog.action, filters.action) : undefined,
        filters.cursor ? afterCursor(auditLog.at, auditLog.id, filters.cursor) : undefined,
      ),
    )
    .orderBy(desc(auditLog.at), desc(auditLog.id))
    .limit(limit + 1);
  return toPage(rows, limit, (r) => ({ at: r.entry.at, id: r.entry.id }));
}
