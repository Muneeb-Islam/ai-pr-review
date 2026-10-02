import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { InvalidCursorError } from "./errors";
import {
  DEFAULT_PAGE_SIZE,
  MAX_PAGE_SIZE,
  clampLimit,
  decodeCursor,
  encodeCursor,
  type Page,
} from "./pagination";
import {
  appendAuditLog,
  insertFindings,
  listAuditLog,
  listFindings,
  listRuns,
  transitionRun,
} from "./tenant";
import {
  createTenant,
  makeRun,
  makeRunInStatus,
  sampleFinding,
  type Tenant,
} from "./testing/fixtures";
import { createTestDatabase, type TestDatabase } from "./testing/testDb";
import type { Run } from "./types";

let t: TestDatabase;
let A: Tenant;
let B: Tenant;
let runsA: Run[];

const BASE = new Date("2031-05-01T00:00:00.000Z").getTime();
const at = (minutes: number) => new Date(BASE + minutes * 60_000);

beforeAll(async () => {
  t = await createTestDatabase();
  A = await createTenant(t.db, "alpha");
  B = await createTenant(t.db, "beta");
  runsA = [];
  // 53 runs in clusters of 5 that share the same queued_at, so the id tiebreak is exercised.
  for (let i = 0; i < 53; i += 1) {
    runsA.push(await makeRun(t.db, A, { at: at(Math.floor(i / 5)) }));
  }
  for (let i = 0; i < 12; i += 1) await makeRun(t.db, B, { at: at(Math.floor(i / 3)) });
}, 60_000);
afterAll(async () => {
  await t.drop();
});

const order = (a: { queuedAt: Date; id: string }, b: { queuedAt: Date; id: string }) =>
  b.queuedAt.getTime() - a.queuedAt.getTime() || (a.id < b.id ? 1 : -1);

async function collect<T>(fetchPage: (cursor?: string) => Promise<Page<T>>) {
  const pages: Page<T>[] = [];
  let cursor: string | undefined;
  for (let guard = 0; guard < 100; guard += 1) {
    const page = await fetchPage(cursor);
    pages.push(page);
    if (page.nextCursor === null) return pages;
    cursor = page.nextCursor;
  }
  throw new Error("pagination did not terminate");
}

describe("cursor pagination of runs", () => {
  it("returns complete, ordered, non-overlapping pages", async () => {
    const pages = await collect((cursor) =>
      listRuns(t.db, [A.installation.id], { limit: 10, ...(cursor ? { cursor } : {}) }),
    );
    expect(pages.map((p) => p.items.length)).toEqual([10, 10, 10, 10, 10, 3]);
    expect(pages.at(-1)!.nextCursor).toBeNull();

    const all = pages.flatMap((p) => p.items);
    expect(new Set(all.map((r) => r.id)).size).toBe(53);
    expect(all.map((r) => r.id).sort()).toEqual(runsA.map((r) => r.id).sort());
    expect(all.every((r) => r.installationId === A.installation.id)).toBe(true);
    expect(all.map((r) => r.id)).toEqual([...all].sort(order).map((r) => r.id));
  });

  it("gives the same pages every time (stable) and the same result for any page size", async () => {
    const ids = async (limit: number) =>
      (
        await collect((cursor) =>
          listRuns(t.db, [A.installation.id], { limit, ...(cursor ? { cursor } : {}) }),
        )
      )
        .flatMap((p) => p.items)
        .map((r) => r.id);
    const reference = await ids(10);
    expect(await ids(10)).toEqual(reference);
    expect(await ids(1)).toEqual(reference);
    expect(await ids(7)).toEqual(reference);
    expect(await ids(53)).toEqual(reference);
    expect(await ids(MAX_PAGE_SIZE)).toEqual(reference);
  });

  it("has no next cursor when everything fits in one page", async () => {
    const page = await listRuns(t.db, [A.installation.id], { limit: 53 });
    expect(page.items).toHaveLength(53);
    expect(page.nextCursor).toBeNull();
  });

  it("is not disturbed by rows inserted or deleted while paging", async () => {
    const first = await listRuns(t.db, [A.installation.id], { limit: 20 });
    // New runs appear at the head and an old one is deleted mid-way.
    const fresh = [
      await makeRun(t.db, A, { at: at(500) }),
      await makeRun(t.db, A, { at: at(501) }),
    ];
    const lastOfFirst = first.items.at(-1)!;
    const toDelete = runsA.find(
      (r) => !first.items.some((x) => x.id === r.id) && r.id !== lastOfFirst.id,
    )!;
    await t.pool.query("delete from review_runs where id = $1", [toDelete.id]);

    const rest = await collect((cursor) =>
      listRuns(t.db, [A.installation.id], { limit: 20, cursor: cursor ?? first.nextCursor! }),
    );
    const seen = [...first.items, ...rest.flatMap((p) => p.items)].map((r) => r.id);
    expect(new Set(seen).size).toBe(seen.length); // no duplicates
    const expected = runsA.map((r) => r.id).filter((id) => id !== toDelete.id);
    expect([...seen].sort()).toEqual([...expected].sort()); // nothing missing, new runs not injected
    for (const f of fresh) expect(seen).not.toContain(f.id);

    // Cleanup so later tests see the original 53.
    await t.pool.query("delete from review_runs where id = any($1)", [fresh.map((r) => r.id)]);
    await t.pool.query(
      `insert into review_runs (id, installation_id, repo_id, pr_number, head_sha, base_sha, base_ref, trigger, queued_at)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [
        toDelete.id,
        toDelete.installationId,
        toDelete.repoId,
        toDelete.prNumber,
        toDelete.headSha,
        toDelete.baseSha,
        toDelete.baseRef,
        toDelete.trigger,
        toDelete.queuedAt,
      ],
    );
  });

  it("pages filtered lists completely too", async () => {
    const running = [];
    for (let i = 0; i < 7; i += 1) {
      running.push(await makeRunInStatus(t.db, A, "running", { at: at(100 + i) }));
    }
    const pages = await collect((cursor) =>
      listRuns(t.db, [A.installation.id], {
        status: ["running"],
        limit: 3,
        ...(cursor ? { cursor } : {}),
      }),
    );
    expect(pages.map((p) => p.items.length)).toEqual([3, 3, 1]);
    expect(
      pages
        .flatMap((p) => p.items)
        .map((r) => r.id)
        .sort(),
    ).toEqual(running.map((r) => r.id).sort());
    for (const r of running) {
      await transitionRun(t.db, A.installation.id, r.id, "cancelled");
    }
    expect((await listRuns(t.db, [A.installation.id], { status: "running" })).items).toHaveLength(
      0,
    );
  });

  it("keeps tenants apart while paging", async () => {
    const both = await collect((cursor) =>
      listRuns(t.db, [A.installation.id, B.installation.id], {
        limit: 9,
        ...(cursor ? { cursor } : {}),
      }),
    );
    const all = both.flatMap((p) => p.items);
    expect(all.filter((r) => r.installationId === B.installation.id)).toHaveLength(12);
    const onlyB = await collect((cursor) =>
      listRuns(t.db, [B.installation.id], { limit: 5, ...(cursor ? { cursor } : {}) }),
    );
    expect(onlyB.flatMap((p) => p.items)).toHaveLength(12);
  });

  it("rejects a malformed cursor", async () => {
    for (const bad of ["garbage", Buffer.from("[]").toString("base64url"), "e30"]) {
      await expect(listRuns(t.db, [A.installation.id], { cursor: bad })).rejects.toBeInstanceOf(
        InvalidCursorError,
      );
    }
  });

  it("defaults and clamps the page size", () => {
    expect(clampLimit(undefined)).toBe(DEFAULT_PAGE_SIZE);
    expect(clampLimit(0)).toBe(DEFAULT_PAGE_SIZE);
    expect(clampLimit(-3)).toBe(DEFAULT_PAGE_SIZE);
    expect(clampLimit(1.5)).toBe(DEFAULT_PAGE_SIZE);
    expect(clampLimit(5)).toBe(5);
    expect(clampLimit(10_000)).toBe(MAX_PAGE_SIZE);
  });

  it("round-trips cursors with millisecond precision", () => {
    const key = {
      at: new Date("2031-05-01T12:34:56.789Z"),
      id: "123e4567-e89b-42d3-a456-426614174000",
    };
    expect(decodeCursor(encodeCursor(key))).toEqual(key);
  });
});

describe("cursor pagination of findings and the audit log", () => {
  it("pages findings across runs with equal queued_at completely and in order", async () => {
    const run1 = await makeRunInStatus(t.db, B, "running", { at: at(900) });
    const run2 = await makeRunInStatus(t.db, B, "running", { at: at(900) });
    const run3 = await makeRunInStatus(t.db, B, "running", { at: at(901) });
    const stored = [];
    for (const run of [run1, run2, run3]) {
      stored.push(
        ...(await insertFindings(
          t.db,
          B.installation.id,
          run.id,
          Array.from({ length: 6 }, () => sampleFinding()),
        )),
      );
    }
    const pages = await collect((cursor) =>
      listFindings(t.db, [B.installation.id], {
        repoId: B.repo.id,
        runId: undefined,
        limit: 4,
        ...(cursor ? { cursor } : {}),
      }),
    );
    const all = pages.flatMap((p) => p.items);
    expect(all.map((f) => f.id).sort()).toEqual(stored.map((f) => f.id).sort());
    expect(new Set(all.map((f) => f.id)).size).toBe(18);
    expect(pages.slice(0, -1).every((p) => p.items.length === 4)).toBe(true);
    // Newest run first; within one queued_at, by finding id descending.
    const queuedAt = new Map([
      [run1.id, run1.queuedAt.getTime()],
      [run2.id, run2.queuedAt.getTime()],
      [run3.id, run3.queuedAt.getTime()],
    ]);
    const sorted = [...all].sort(
      (a, b) => queuedAt.get(b.runId)! - queuedAt.get(a.runId)! || (a.id < b.id ? 1 : -1),
    );
    expect(all.map((f) => f.id)).toEqual(sorted.map((f) => f.id));
  });

  it("pages the audit log completely", async () => {
    for (let i = 0; i < 11; i += 1) {
      await appendAuditLog(t.db, A.installation.id, {
        action: "settings.update",
        target: `repo:${i}`,
        at: at(Math.floor(i / 4)),
      });
    }
    const pages = await collect((cursor) =>
      listAuditLog(t.db, [A.installation.id], { limit: 4, ...(cursor ? { cursor } : {}) }),
    );
    expect(pages.map((p) => p.items.length)).toEqual([4, 4, 3]);
    expect(new Set(pages.flatMap((p) => p.items).map((e) => e.id)).size).toBe(11);
  });
});
