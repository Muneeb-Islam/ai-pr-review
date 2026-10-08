import {
  createSession,
  deleteSession,
  getSessionWithUser,
  touchSession,
  type SessionRecord,
  type User,
} from "@ai-pr-review/db/system";
import type { Database } from "@ai-pr-review/db";
import type { PlatformConfig } from "../config";
import { csrfTokenFor, randomToken, safeEqual, sign, unsign } from "./signing";

export const SESSION_COOKIE = "aipr_session";
const COOKIE_LABEL = "session";
/** The idle clock is refreshed at most this often, so a busy page does not write on every request. */
const TOUCH_INTERVAL_MS = 60_000;

export interface AuthContext {
  user: User;
  session: SessionRecord;
}

type SessionConfig = Pick<PlatformConfig, "sessionSecret" | "sessionIdleMs" | "sessionAbsoluteMs">;

/**
 * Server-side sessions (PL-12). The cookie carries only a random session id plus its signature; everything
 * else lives in PostgreSQL, so logout and expiry are real (the row is deleted) and a stolen cookie value
 * cannot be forged into another session.
 */
export class SessionService {
  constructor(
    private readonly db: Database,
    private readonly config: SessionConfig,
    private readonly now: () => Date = () => new Date(),
  ) {}

  /** Creates a session for a user who has just signed in. Always a new id: login rotates the session. */
  async start(
    userId: string,
  ): Promise<{ session: SessionRecord; cookieValue: string; maxAgeSeconds: number }> {
    const now = this.now();
    const session = await createSession(this.db, {
      userId,
      csrfSecret: randomToken(),
      expiresAt: new Date(now.getTime() + this.config.sessionAbsoluteMs),
      now,
    });
    return {
      session,
      cookieValue: sign(this.config.sessionSecret, COOKIE_LABEL, session.id),
      maxAgeSeconds: Math.floor(this.config.sessionAbsoluteMs / 1000),
    };
  }

  /** The signed-in user for a cookie value, or undefined if it is missing, forged, expired or idle too long. */
  async resolve(cookieValue: string | undefined): Promise<AuthContext | undefined> {
    if (!cookieValue) return undefined;
    const sessionId = unsign(this.config.sessionSecret, COOKIE_LABEL, cookieValue);
    if (!sessionId) return undefined;
    const found = await getSessionWithUser(this.db, sessionId);
    if (!found) return undefined;

    const now = this.now();
    const idleDeadline = found.session.lastSeenAt.getTime() + this.config.sessionIdleMs;
    if (found.session.expiresAt <= now || idleDeadline <= now.getTime()) {
      await deleteSession(this.db, found.session.id);
      return undefined;
    }
    if (now.getTime() - found.session.lastSeenAt.getTime() > TOUCH_INTERVAL_MS) {
      await touchSession(this.db, found.session.id, now);
      return { user: found.user, session: { ...found.session, lastSeenAt: now } };
    }
    return found;
  }

  /**
   * Whether a session is still within its absolute and idle limits, without counting as activity (an open
   * event stream must not keep an idle session alive) and without deleting anything.
   */
  async isActive(sessionId: string): Promise<boolean> {
    const found = await getSessionWithUser(this.db, sessionId);
    if (!found) return false;
    const now = this.now().getTime();
    return (
      found.session.expiresAt.getTime() > now &&
      found.session.lastSeenAt.getTime() + this.config.sessionIdleMs > now
    );
  }

  /** The session id behind a cookie value, without checking expiry (to remove it on login or logout). */
  idOf(cookieValue: string | undefined): string | undefined {
    return cookieValue ? unsign(this.config.sessionSecret, COOKIE_LABEL, cookieValue) : undefined;
  }

  async end(sessionId: string): Promise<void> {
    await deleteSession(this.db, sessionId);
  }

  csrfToken(session: SessionRecord): string {
    return csrfTokenFor(this.config.sessionSecret, session.id, session.csrfSecret);
  }

  checkCsrf(session: SessionRecord, token: string | undefined): boolean {
    return token !== undefined && safeEqual(token, this.csrfToken(session));
  }
}
