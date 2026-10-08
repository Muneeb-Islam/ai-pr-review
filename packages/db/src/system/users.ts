import { and, eq, notInArray } from "drizzle-orm";
import type { AccountType, InstallationRole } from "@ai-pr-review/shared";
import type { Database } from "../client";
import { installations, repositories, userInstallations, userRepositories, users } from "../schema";
import { isUuid } from "../scope";

export type User = typeof users.$inferSelect;

export interface UserInput {
  githubUserId: number;
  login: string;
  avatarUrl?: string;
}

export async function upsertUser(db: Database, input: UserInput): Promise<User> {
  const [row] = await db
    .insert(users)
    .values({
      githubUserId: input.githubUserId,
      login: input.login,
      avatarUrl: input.avatarUrl ?? null,
    })
    .onConflictDoUpdate({
      target: users.githubUserId,
      set: { login: input.login, avatarUrl: input.avatarUrl ?? null },
    })
    .returning();
  return row!;
}

/**
 * Replaces the cached set of installations a user can access (design §9: re-checked against GitHub with
 * a short cache). Installations missing from `entries` are removed from the user.
 */
export async function replaceUserInstallations(
  db: Database,
  userId: string,
  entries: ReadonlyArray<{ installationId: string; role: InstallationRole }>,
  at: Date = new Date(),
): Promise<void> {
  await db.transaction(async (tx) => {
    const keep = entries.map((e) => e.installationId);
    await tx
      .delete(userInstallations)
      .where(
        keep.length === 0
          ? eq(userInstallations.userId, userId)
          : and(
              eq(userInstallations.userId, userId),
              notInArray(userInstallations.installationId, keep),
            ),
      );
    for (const entry of entries) {
      await tx
        .insert(userInstallations)
        .values({ userId, installationId: entry.installationId, role: entry.role, refreshedAt: at })
        .onConflictDoUpdate({
          target: [userInstallations.userId, userInstallations.installationId],
          set: { role: entry.role, refreshedAt: at },
        });
    }
  });
}

export interface UserAccess {
  installations: ReadonlyArray<{ installationId: string; role: InstallationRole }>;
  repositories: ReadonlyArray<{ installationId: string; repoId: string; role: InstallationRole }>;
}

/**
 * Replaces everything cached about what a user may reach (login refresh): installations and repositories
 * missing from `access` are removed, the rest are inserted or updated, in one transaction.
 */
export async function replaceUserAccess(
  db: Database,
  userId: string,
  access: UserAccess,
  at: Date = new Date(),
): Promise<void> {
  await db.transaction(async (tx) => {
    const txDb = tx as unknown as Database;
    await replaceUserInstallations(txDb, userId, access.installations, at);
    const keep = access.repositories.map((r) => r.repoId);
    await tx
      .delete(userRepositories)
      .where(
        keep.length === 0
          ? eq(userRepositories.userId, userId)
          : and(eq(userRepositories.userId, userId), notInArray(userRepositories.repoId, keep)),
      );
    for (const repo of access.repositories) {
      await tx
        .insert(userRepositories)
        .values({
          userId,
          installationId: repo.installationId,
          repoId: repo.repoId,
          role: repo.role,
          refreshedAt: at,
        })
        .onConflictDoUpdate({
          target: [userRepositories.userId, userRepositories.repoId],
          set: { role: repo.role, refreshedAt: at },
        });
    }
  });
}

export interface RepoAccess {
  repoId: string;
  installationId: string;
  githubInstallationId: number;
  fullName: string;
  role: InstallationRole;
  refreshedAt: Date;
}

/**
 * What the user may do on one repository, from the cache. Undefined when there is no cached access, or the
 * repository or its installation is no longer active (AC-22), or the user lost the installation.
 */
export async function getUserRepoAccess(
  db: Database,
  userId: string,
  repoId: string,
): Promise<RepoAccess | undefined> {
  if (!isUuid(userId) || !isUuid(repoId)) return undefined;
  const [row] = await db
    .select({
      repoId: userRepositories.repoId,
      installationId: userRepositories.installationId,
      githubInstallationId: installations.githubInstallationId,
      fullName: repositories.fullName,
      role: userRepositories.role,
      refreshedAt: userRepositories.refreshedAt,
    })
    .from(userRepositories)
    .innerJoin(repositories, eq(repositories.id, userRepositories.repoId))
    .innerJoin(installations, eq(installations.id, userRepositories.installationId))
    .innerJoin(
      userInstallations,
      and(
        eq(userInstallations.userId, userRepositories.userId),
        eq(userInstallations.installationId, userRepositories.installationId),
      ),
    )
    .where(
      and(
        eq(userRepositories.userId, userId),
        eq(userRepositories.repoId, repoId),
        eq(repositories.active, true),
        eq(installations.status, "active"),
      ),
    );
  return row;
}

/** Every repository the user may reach (active ones only), for list endpoints. */
export async function listUserRepoAccess(
  db: Database,
  userId: string,
): Promise<
  Array<{ repoId: string; installationId: string; role: InstallationRole; refreshedAt: Date }>
> {
  if (!isUuid(userId)) return [];
  return db
    .select({
      repoId: userRepositories.repoId,
      installationId: userRepositories.installationId,
      role: userRepositories.role,
      refreshedAt: userRepositories.refreshedAt,
    })
    .from(userRepositories)
    .innerJoin(repositories, eq(repositories.id, userRepositories.repoId))
    .innerJoin(installations, eq(installations.id, userRepositories.installationId))
    .innerJoin(
      userInstallations,
      and(
        eq(userInstallations.userId, userRepositories.userId),
        eq(userInstallations.installationId, userRepositories.installationId),
      ),
    )
    .where(
      and(
        eq(userRepositories.userId, userId),
        eq(repositories.active, true),
        eq(installations.status, "active"),
      ),
    );
}

/** Sets (or, with `null`, removes) the cached access of a user to one repository: the on-demand refresh. */
export async function setUserRepoAccess(
  db: Database,
  userId: string,
  installationId: string,
  repoId: string,
  role: InstallationRole | null,
  at: Date = new Date(),
): Promise<void> {
  if (!isUuid(userId) || !isUuid(installationId) || !isUuid(repoId)) return;
  if (role === null) {
    await db
      .delete(userRepositories)
      .where(and(eq(userRepositories.userId, userId), eq(userRepositories.repoId, repoId)));
    return;
  }
  await db
    .insert(userRepositories)
    .values({ userId, installationId, repoId, role, refreshedAt: at })
    .onConflictDoUpdate({
      target: [userRepositories.userId, userRepositories.repoId],
      set: { role, refreshedAt: at },
    });
}

export interface InstallationAccess {
  installationId: string;
  githubInstallationId: number;
  accountLogin: string;
  accountType: AccountType;
  role: InstallationRole;
  refreshedAt: Date;
}

/** What the user may do on one active installation, from the cache. */
export async function getUserInstallationAccess(
  db: Database,
  userId: string,
  installationId: string,
): Promise<InstallationAccess | undefined> {
  if (!isUuid(userId) || !isUuid(installationId)) return undefined;
  const [row] = await db
    .select({
      installationId: installations.id,
      githubInstallationId: installations.githubInstallationId,
      accountLogin: installations.accountLogin,
      accountType: installations.accountType,
      role: userInstallations.role,
      refreshedAt: userInstallations.refreshedAt,
    })
    .from(userInstallations)
    .innerJoin(installations, eq(installations.id, userInstallations.installationId))
    .where(
      and(
        eq(userInstallations.userId, userId),
        eq(userInstallations.installationId, installationId),
        eq(installations.status, "active"),
      ),
    );
  return row;
}

/** Every active installation the user can access, with their role (the `/api/me` list). */
export async function listUserInstallationAccess(
  db: Database,
  userId: string,
): Promise<InstallationAccess[]> {
  if (!isUuid(userId)) return [];
  return db
    .select({
      installationId: installations.id,
      githubInstallationId: installations.githubInstallationId,
      accountLogin: installations.accountLogin,
      accountType: installations.accountType,
      role: userInstallations.role,
      refreshedAt: userInstallations.refreshedAt,
    })
    .from(userInstallations)
    .innerJoin(installations, eq(installations.id, userInstallations.installationId))
    .where(and(eq(userInstallations.userId, userId), eq(installations.status, "active")))
    .orderBy(installations.accountLogin, installations.id);
}

/** Sets (or, with `null`, removes) the cached role of a user on one installation. */
export async function setUserInstallationRole(
  db: Database,
  userId: string,
  installationId: string,
  role: InstallationRole | null,
  at: Date = new Date(),
): Promise<void> {
  if (!isUuid(userId) || !isUuid(installationId)) return;
  if (role === null) {
    await db
      .delete(userInstallations)
      .where(
        and(
          eq(userInstallations.userId, userId),
          eq(userInstallations.installationId, installationId),
        ),
      );
    // Without the installation there is no access to its repositories either.
    await db
      .delete(userRepositories)
      .where(
        and(
          eq(userRepositories.userId, userId),
          eq(userRepositories.installationId, installationId),
        ),
      );
    return;
  }
  await db
    .insert(userInstallations)
    .values({ userId, installationId, role, refreshedAt: at })
    .onConflictDoUpdate({
      target: [userInstallations.userId, userInstallations.installationId],
      set: { role, refreshedAt: at },
    });
}

/**
 * The caller scope: ids of the **active** installations the user can access. Suspended and deleted
 * installations drop out, which hides their data from the dashboard (AC-22).
 */
export async function listAccessibleInstallationIds(
  db: Database,
  userId: string,
): Promise<string[]> {
  const rows = await db
    .select({ id: installations.id })
    .from(userInstallations)
    .innerJoin(installations, eq(installations.id, userInstallations.installationId))
    .where(and(eq(userInstallations.userId, userId), eq(installations.status, "active")));
  return rows.map((r) => r.id);
}
