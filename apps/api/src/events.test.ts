// GET /api/events (PL-14): the live stream of run.updated. Real HTTP over a local port, because the point is
// what a browser's EventSource sees: headers, framing, heartbeats, and who receives which event.
import type { RunUpdatedEvent } from "@ai-pr-review/queue";
import { deleteSession, setUserRepoAccess } from "@ai-pr-review/db/system";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createHarness,
  createWorld,
  type Harness,
  type Session,
  type World,
} from "./testing/harness";

let h: Harness;
let world: World;
let alice: Session;
let dana: Session;
let bob: Session;
let base: string;

beforeAll(async () => {
  h = await createHarness({ stream: { heartbeatMs: 40, recheckMs: 150 } });
  world = await createWorld(h);
  h.github.users.set("dana", {
    id: 4242,
    login: "dana",
    installations: [
      {
        id: world.alpha.installation.githubInstallationId,
        accountLogin: world.alpha.installation.accountLogin,
        accountType: "organization",
        orgRole: "member",
        repos: [
          { id: world.alpha.repo.githubRepoId, fullName: world.alpha.repo.fullName, admin: false },
        ],
      },
    ],
  });
  [alice, dana, bob] = await Promise.all([
    h.signIn(world.alice),
    h.signIn("dana"),
    h.signIn(world.bob),
  ]);
  base = await h.app.listen({ host: "127.0.0.1", port: 0 });
}, 60_000);
afterAll(async () => {
  await h.close();
});

/** An open stream: everything received so far, and a way to wait for more or to hang up. */
interface Stream {
  response: Response;
  text(): string;
  /** Resolves when the received text satisfies `done`; rejects after `ms`. */
  until(done: (text: string) => boolean, ms?: number): Promise<string>;
  /** True once the server ended the stream. */
  ended(): boolean;
  close(): void;
}

const openStreams: Stream[] = [];

async function connect(session: Session | undefined): Promise<Stream> {
  const controller = new AbortController();
  const response = await fetch(`${base}/api/events`, {
    headers: session ? { cookie: session.cookie } : {},
    signal: controller.signal,
  });
  let text = "";
  let ended = false;
  const waiters = new Set<() => void>();
  if (response.body) {
    void (async () => {
      const reader = response.body!.getReader();
      const decoder = new TextDecoder();
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          text += decoder.decode(value, { stream: true });
          waiters.forEach((w) => w());
        }
      } catch {
        // aborted by the test
      }
      ended = true;
      waiters.forEach((w) => w());
    })();
  }
  const stream: Stream = {
    response,
    text: () => text,
    ended: () => ended,
    until: (done, ms = 2000) =>
      new Promise((resolve, reject) => {
        const check = () => {
          if (done(text)) {
            waiters.delete(check);
            clearTimeout(timer);
            resolve(text);
          }
        };
        const timer = setTimeout(() => {
          waiters.delete(check);
          reject(new Error(`Timed out. Received so far:\n${text}`));
        }, ms);
        waiters.add(check);
        check();
      }),
    close: () => controller.abort(),
  };
  openStreams.push(stream);
  return stream;
}

afterAll(() => openStreams.forEach((s) => s.close()));

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const event = (
  repoId: string,
  runId: string,
  status: RunUpdatedEvent["status"],
): RunUpdatedEvent => ({
  type: "run.updated",
  runId,
  installationId: world.alpha.installation.id,
  repoId,
  status,
  at: "2026-10-05T10:00:00.000Z",
});
const dataOf = (text: string) =>
  [...text.matchAll(/event: run\.updated\ndata: (.*)\n\n/g)].map((m) => JSON.parse(m[1]!));

describe("GET /api/events", () => {
  it("refuses anonymous callers", async () => {
    const res = await fetch(`${base}/api/events`);
    expect(res.status).toBe(401);
  });

  it("answers as an event stream that proxies must not buffer, and says hello", async () => {
    const s = await connect(alice);
    expect(s.response.status).toBe(200);
    expect(s.response.headers.get("content-type")).toContain("text/event-stream");
    expect(s.response.headers.get("cache-control")).toContain("no-store");
    expect(s.response.headers.get("x-accel-buffering")).toBe("no");
    expect(s.response.headers.get("x-content-type-options")).toBe("nosniff");
    await s.until((t) => t.includes("event: ready"));
    expect(s.text()).toContain("retry: 3000");
    s.close();
  });

  it("sends run.updated for the user's repositories: ids and status only", async () => {
    const s = await connect(alice);
    await s.until((t) => t.includes("event: ready"));
    h.events.emit(event(world.alpha.repo.id, "run-1", "running"));
    await s.until((t) => t.includes('"run-1"'));
    expect(dataOf(s.text())).toEqual([
      {
        run_id: "run-1",
        repo_id: world.alpha.repo.id,
        status: "running",
        at: "2026-10-05T10:00:00.000Z",
      },
    ]);
    s.close();
  });

  it("filters by repository access: nothing about repositories the user cannot reach", async () => {
    const forDana = await connect(dana);
    const forBob = await connect(bob);
    await Promise.all([
      forDana.until((t) => t.includes("event: ready")),
      forBob.until((t) => t.includes("event: ready")),
    ]);
    // dana: the second alpha repository is not hers; bob: none of alpha. Unknown repositories too.
    h.events.emit(event(world.alpha.repo2.id, "hidden-from-dana", "queued"));
    h.events.emit(event("00000000-0000-4000-8000-000000000000", "unknown-repo", "queued"));
    h.events.emit(event(world.alpha.repo.id, "visible-to-dana", "queued"));
    await forDana.until((t) => t.includes("visible-to-dana"));
    await sleep(50);
    expect(forDana.text()).not.toContain("hidden-from-dana");
    expect(forDana.text()).not.toContain("unknown-repo");
    expect(forBob.text()).not.toContain("run.updated");
    forDana.close();
    forBob.close();
  });

  it("keeps the connection alive with heartbeat comments", async () => {
    const s = await connect(alice);
    await s.until((t) => (t.match(/: heartbeat/g) ?? []).length >= 2);
    s.close();
  });

  it("stops sending for a repository the user lost access to", async () => {
    const s = await connect(dana);
    await s.until((t) => t.includes("event: ready"));
    h.events.emit(event(world.alpha.repo.id, "before-revocation", "queued"));
    await s.until((t) => t.includes("before-revocation"));

    await setUserRepoAccess(
      h.t.db,
      dana.userId,
      world.alpha.installation.id,
      world.alpha.repo.id,
      null,
    );
    await sleep(400); // longer than the re-check interval
    h.events.emit(event(world.alpha.repo.id, "after-revocation", "queued"));
    await sleep(100);
    expect(s.text()).not.toContain("after-revocation");
    s.close();
  });

  it("ends the stream when the session ends", async () => {
    const own = await h.signIn("bob");
    const s = await connect(own);
    await s.until((t) => t.includes("event: ready"));
    await deleteSession(h.t.db, sessionIdOf(own));
    await s.until((t) => t.includes("event: session.expired"), 3000);
    await sleep(50);
    expect(s.ended()).toBe(true);
  });

  it("stops listening when the client goes away", async () => {
    const before = h.events.size;
    const s = await connect(alice);
    await s.until((t) => t.includes("event: ready"));
    expect(h.events.size).toBe(before + 1);
    s.close();
    for (let i = 0; i < 40 && h.events.size > before; i++) await sleep(25);
    expect(h.events.size).toBe(before);
  });

  it("lets one user keep a bounded number of streams: the oldest makes room", async () => {
    const user = await h.signIn("alice");
    const streams: Stream[] = [];
    for (let i = 0; i < 9; i++) {
      const s = await connect(user);
      await s.until((t) => t.includes("event: ready"));
      streams.push(s);
    }
    for (let i = 0; i < 40 && !streams[0]!.ended(); i++) await sleep(25);
    expect(streams[0]!.ended()).toBe(true);
    expect(streams[8]!.ended()).toBe(false);
    streams.forEach((s) => s.close());
  });
});

/** The session id inside a signed cookie (`<id>.<signature>`). */
function sessionIdOf(session: Session): string {
  return decodeURIComponent(session.cookie.split("=")[1]!).split(".")[0]!;
}
