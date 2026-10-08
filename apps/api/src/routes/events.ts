// GET /api/events (PL-14): a server-sent-event stream of `run.updated` for the repositories the signed-in
// user can reach. The events carry ids and a status only; the dashboard refetches through the authorised
// REST endpoints, so the stream cannot leak run content even if the filtering were wrong.
import { PassThrough } from "node:stream";
import type { RunUpdatedEvent } from "@ai-pr-review/queue";
import type { AuthContext } from "../auth/sessions";
import { HttpError } from "../http/errors";
import type { Handlers, Platform, StreamTimings } from "../http/platform";

type EventHandlers = Pick<Handlers, "events">;

export const DEFAULT_STREAM_TIMINGS: StreamTimings = { heartbeatMs: 15_000, recheckMs: 60_000 };
/** A user with more tabs than this loses the oldest stream (a reconnect after a drop must always succeed). */
const MAX_STREAMS_PER_USER = 8;
/** An event for an unknown repository triggers at most one access re-check per interval. */
const MIN_RECHECK_GAP_MS = 5_000;
const RECONNECT_MS = 3_000;

const open = new Map<string, Set<() => void>>();

const frame = (event: string, data: unknown) =>
  `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;

async function allowedRepoIds(platform: Platform, auth: AuthContext): Promise<Set<string>> {
  try {
    const access = await platform.access.listRepoAccess({
      id: auth.user.id,
      login: auth.user.login,
    });
    return new Set(access.keys());
  } catch {
    // Fail closed: nothing is sent until the next check succeeds.
    return new Set();
  }
}

export const eventHandlers: EventHandlers = {
  async events({ request, reply, platform, auth }) {
    const source = platform.events;
    if (!source) throw new HttpError(503, "unavailable", "Live updates are not available");
    const timings = { ...DEFAULT_STREAM_TIMINGS, ...platform.stream };
    const sessionId = auth.session.id;
    const userId = auth.user.id;

    const stream = new PassThrough();
    let allowed = await allowedRepoIds(platform, auth);
    let lastCheck = Date.now();
    let closed = false;
    // Everything to undo when the stream ends: the event subscription and the heartbeat timer.
    const disposers: Array<() => void> = [];

    const streams = open.get(userId) ?? new Set<() => void>();
    open.set(userId, streams);

    const close = () => {
      if (closed) return;
      closed = true;
      disposers.forEach((dispose) => dispose());
      streams.delete(close);
      if (streams.size === 0) open.delete(userId);
      stream.end();
    };

    // The oldest stream makes room for the newest.
    while (streams.size >= MAX_STREAMS_PER_USER) streams.values().next().value?.();
    streams.add(close);

    const recheck = async (): Promise<boolean> => {
      if (!(await platform.sessions.isActive(sessionId).catch(() => false))) {
        if (!closed) stream.write(frame("session.expired", {}));
        close();
        return false;
      }
      allowed = await allowedRepoIds(platform, auth);
      lastCheck = Date.now();
      return true;
    };

    const unsubscribe = source.subscribe((event: RunUpdatedEvent) => {
      void (async () => {
        if (closed) return;
        if (!allowed.has(event.repoId)) {
          // Maybe a repository the user gained access to after the stream opened.
          if (Date.now() - lastCheck < MIN_RECHECK_GAP_MS) return;
          if (!(await recheck()) || !allowed.has(event.repoId)) return;
        }
        if (closed) return;
        stream.write(
          frame("run.updated", {
            run_id: event.runId,
            repo_id: event.repoId,
            status: event.status,
            at: event.at,
          }),
        );
      })();
    });

    disposers.push(unsubscribe);

    const timer = setInterval(() => {
      if (closed) return;
      if (Date.now() - lastCheck >= timings.recheckMs) {
        void recheck();
        return;
      }
      stream.write(": heartbeat\n\n");
    }, timings.heartbeatMs);
    timer.unref();
    disposers.push(() => clearInterval(timer));

    request.raw.on("close", close);
    stream.on("close", close);
    stream.write(`retry: ${RECONNECT_MS}\n\n`);
    stream.write(frame("ready", {}));

    void reply
      .header("content-type", "text/event-stream; charset=utf-8")
      .header("cache-control", "no-store, no-transform")
      // Proxies (nginx) buffer responses unless told not to: events would arrive in bursts.
      .header("x-accel-buffering", "no")
      .send(stream);
    return undefined;
  },
};
