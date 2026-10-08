// What the publisher records (Phase 9) against a real PostgreSQL: posted comments are idempotent, posted
// findings are marked by fingerprint, findings that cannot be posted become suppressed, and the fingerprints
// already posted for a head SHA are found across runs of one repository only.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  listFindingsForRun,
  listPostedComments,
  listPostedFingerprints,
  markRunFindingsPosted,
  recordPostedComments,
  suppressRunFindings,
} from "./tenant";
import { insertFindings } from "./tenant";
import { createTenant, makeRun, sampleFinding, type Tenant } from "./testing/fixtures";
import { createTestDatabase, type TestDatabase } from "./testing/testDb";

let t: TestDatabase;
let A: Tenant;
let B: Tenant;

beforeAll(async () => {
  t = await createTestDatabase();
  A = await createTenant(t.db, "pub-alpha");
  B = await createTenant(t.db, "pub-beta");
}, 30_000);
afterAll(async () => {
  await t.drop();
});

const SHA = "a".repeat(40);

describe("recordPostedComments", () => {
  it("records a run's comments and does not list the same comment twice when repeated", async () => {
    const run = await makeRun(t.db, A, { prNumber: 1 });
    const input = [
      {
        kind: "review_comment" as const,
        githubId: 9_000_000_001,
        fingerprint: "f1".padEnd(16, "0"),
        headSha: SHA,
      },
      { kind: "summary" as const, githubId: 9_000_000_002, headSha: SHA },
    ];

    const first = await recordPostedComments(t.db, A.installation.id, run.id, input);
    const second = await recordPostedComments(t.db, A.installation.id, run.id, [
      ...input,
      {
        kind: "review_comment" as const,
        githubId: 9_000_000_003,
        fingerprint: "f2".padEnd(16, "0"),
        headSha: SHA,
      },
    ]);

    expect(first).toHaveLength(2);
    expect(second).toHaveLength(1); // only the new one
    const all = await listPostedComments(t.db, [A.installation.id], run.id);
    expect(all.map((c) => c.githubId).sort()).toEqual([
      9_000_000_001, 9_000_000_002, 9_000_000_003,
    ]);
  });

  it("ignores duplicates inside one batch and refuses another tenant's run", async () => {
    const run = await makeRun(t.db, A, { prNumber: 2 });
    const dup = {
      kind: "review_comment" as const,
      githubId: 9_000_000_010,
      fingerprint: "f9".padEnd(16, "0"),
      headSha: SHA,
    };
    expect(await recordPostedComments(t.db, A.installation.id, run.id, [dup, dup])).toHaveLength(1);
    await expect(recordPostedComments(t.db, B.installation.id, run.id, [dup])).rejects.toThrow();
  });
});

describe("marking and suppressing findings by fingerprint", () => {
  it("marks only the named accepted findings as posted", async () => {
    const run = await makeRun(t.db, A, { prNumber: 3 });
    const [one, two] = await insertFindings(t.db, A.installation.id, run.id, [
      sampleFinding({ fingerprint: "aaaa000000000001" }),
      sampleFinding({ fingerprint: "aaaa000000000002" }),
      sampleFinding({ fingerprint: "aaaa000000000003", suppressedReason: "below_threshold" }),
    ]);

    const changed = await markRunFindingsPosted(t.db, A.installation.id, run.id, [
      { agent: "code_review", fingerprint: one!.fingerprint },
      { agent: "code_review", fingerprint: "aaaa000000000003" }, // suppressed: never marked
    ]);

    expect(changed).toBe(1);
    const rows = await listFindingsForRun(t.db, [A.installation.id], run.id);
    expect(rows.find((f) => f.id === one!.id)!.posted).toBe(true);
    expect(rows.find((f) => f.id === two!.id)!.posted).toBe(false);
    // Repeating is harmless, and another installation changes nothing.
    expect(
      await markRunFindingsPosted(t.db, A.installation.id, run.id, [
        { agent: "code_review", fingerprint: one!.fingerprint },
      ]),
    ).toBe(1);
    expect(
      await markRunFindingsPosted(t.db, B.installation.id, run.id, [
        { agent: "code_review", fingerprint: two!.fingerprint },
      ]),
    ).toBe(0);
  });

  it("turns findings that cannot be posted into suppressed ones, and leaves posted findings alone", async () => {
    const run = await makeRun(t.db, A, { prNumber: 4 });
    const [stale, posted] = await insertFindings(t.db, A.installation.id, run.id, [
      sampleFinding({ fingerprint: "bbbb000000000001" }),
      sampleFinding({ fingerprint: "bbbb000000000002", posted: true }),
    ]);

    const changed = await suppressRunFindings(
      t.db,
      A.installation.id,
      run.id,
      [
        { agent: "code_review", fingerprint: stale!.fingerprint },
        { agent: "code_review", fingerprint: posted!.fingerprint },
      ],
      "invalid_line",
    );

    expect(changed).toBe(1);
    const all = await listFindingsForRun(t.db, [A.installation.id], run.id, {
      includeSuppressed: true,
    });
    expect(all.find((f) => f.id === stale!.id)!.suppressedReason).toBe("invalid_line");
    expect(all.find((f) => f.id === posted!.id)!.suppressedReason).toBeNull();
    const visible = await listFindingsForRun(t.db, [A.installation.id], run.id);
    expect(visible.map((f) => f.id)).toEqual([posted!.id]);
  });

  it("copes with an identical suppressed row already being there", async () => {
    const run = await makeRun(t.db, A, { prNumber: 5 });
    await insertFindings(t.db, A.installation.id, run.id, [
      sampleFinding({ fingerprint: "cccc000000000001" }),
      sampleFinding({ fingerprint: "cccc000000000001", suppressedReason: "invalid_line" }),
    ]);
    const changed = await suppressRunFindings(
      t.db,
      A.installation.id,
      run.id,
      [{ agent: "code_review", fingerprint: "cccc000000000001" }],
      "invalid_line",
    );
    expect(changed).toBe(1);
  });
});

describe("listPostedFingerprints", () => {
  it("finds what any run of the repository posted for the head SHA, and nothing of other commits or tenants", async () => {
    const C = await createTenant(t.db, "pub-gamma");
    const other = "b".repeat(40);
    const first = await makeRun(t.db, C, { prNumber: 6, headSha: SHA });
    const second = await makeRun(t.db, C, { prNumber: 6, headSha: SHA });
    await recordPostedComments(t.db, C.installation.id, first.id, [
      {
        kind: "review_comment",
        githubId: 9_100_000_001,
        fingerprint: "dddd000000000001",
        headSha: SHA,
      },
      {
        kind: "review_comment",
        githubId: 9_100_000_002,
        fingerprint: "dddd000000000002",
        headSha: other,
      },
      { kind: "summary", githubId: 9_100_000_003, headSha: SHA },
    ]);
    await recordPostedComments(t.db, C.installation.id, second.id, [
      {
        kind: "review_comment",
        githubId: 9_100_000_004,
        fingerprint: "dddd000000000004",
        headSha: SHA,
      },
    ]);
    const foreign = await makeRun(t.db, B, { prNumber: 6, headSha: SHA });
    await recordPostedComments(t.db, B.installation.id, foreign.id, [
      {
        kind: "review_comment",
        githubId: 9_100_000_005,
        fingerprint: "dddd000000000005",
        headSha: SHA,
      },
    ]);

    const found = await listPostedFingerprints(t.db, [C.installation.id], C.repo.id, SHA);
    expect(found.sort()).toEqual(["dddd000000000001", "dddd000000000004"]);
    expect(await listPostedFingerprints(t.db, [B.installation.id], C.repo.id, SHA)).toEqual([]);
    expect(await listPostedFingerprints(t.db, [C.installation.id], "not-a-uuid", SHA)).toEqual([]);
  });
});
