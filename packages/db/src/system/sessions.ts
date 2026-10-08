import { and, eq, lt, ne, or } from "drizzle-orm";
import type { Database } from "../client";
import { sessions, users } from "../schema";
import { isUuid } from "../scope";
import type { User } from "./users";

export type SessionRecord = typeof sessions.$inferSelect;

export interface NewSession {
  userId: string;
  /** Random per-session value the CSRF token is derived from. */
  csrfSecret: string;
  /** Absolute end of the session. */
  expiresAt: Date;
  now?: Date;
}

export async function createSession(db: Database, input: NewSession): Promise<SessionRecord> {
  const now = input.now ?? new Date();
  const [row] = await db
    .insert(sessions)
    .values({
      userId: input.userId,
      csrfSecret: input.csrfSecret,
      expiresAt: input.expiresAt,
      lastSeenAt: now,
      createdAt: now,
    })
    .returning();
  return row!;
}

/** The session and its user, or undefined for an unknown or malformed id. Expiry is the caller's decision. */
export async function getSessionWithUser(
  db: Database,
  sessionId: string,
): Promise<{ session: SessionRecord; user: User } | undefined> {
  if (!isUuid(sessionId)) return undefined;
  const [row] = await db
    .select({ session: sessions, user: users })
    .from(sessions)
    .innerJoin(users, eq(users.id, sessions.userId))
    .where(eq(sessions.id, sessionId));
  return row;
}

export async function touchSession(db: Database, sessionId: string, at: Date): Promise<void> {
  if (!isUuid(sessionId)) return;
  await db.update(sessions).set({ lastSeenAt: at }).where(eq(sessions.id, sessionId));
}

/** Logout and rotation. Deleting an unknown id is not an error. */
export async function deleteSession(db: Database, sessionId: string): Promise<void> {
  if (!isUuid(sessionId)) return;
  await db.delete(sessions).where(eq(sessions.id, sessionId));
}

/** Ends every session of a user, optionally keeping one ("sign out everywhere else"). */
export async function deleteUserSessions(
  db: Database,
  userId: string,
  exceptSessionId?: string,
): Promise<number> {
  if (!isUuid(userId)) return 0;
  const rows = await db
    .delete(sessions)
    .where(
      and(
        eq(sessions.userId, userId),
        exceptSessionId && isUuid(exceptSessionId) ? ne(sessions.id, exceptSessionId) : undefined,
      ),
    )
    .returning({ id: sessions.id });
  return rows.length;
}

/** Housekeeping: removes sessions past their absolute end or idle for longer than `idleMs`. */
export async function deleteExpiredSessions(
  db: Database,
  idleMs: number,
  now: Date = new Date(),
): Promise<number> {
  const rows = await db
    .delete(sessions)
    .where(
      or(lt(sessions.expiresAt, now), lt(sessions.lastSeenAt, new Date(now.getTime() - idleMs))),
    )
    .returning({ id: sessions.id });
  return rows.length;
}
