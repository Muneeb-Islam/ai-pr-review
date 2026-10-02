import { and, eq, notInArray } from "drizzle-orm";
import type { InstallationRole } from "@ai-pr-review/shared";
import type { Database } from "../client";
import { installations, userInstallations, users } from "../schema";

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
