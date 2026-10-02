// Run creation for eligible pull requests (Phase 3): supersede older active runs, dedupe, concurrency.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { InvalidInputError, NotFoundError } from "./errors";
import {
  createRunSupersedingOlder,
  getRepositoryByGitHubId,
  getRun,
  getRunByCheckRunId,
  listRunsForPullRequest,
  setAllRepositoriesActive,
  updateRunDetails,
  upsertRepository,
} from "./tenant";
import {
  getWebhookDelivery,
  markWebhookDeliveryProcessed,
  reclaimFailedWebhookDelivery,
  recordWebhookDelivery,
} from "./system";
import { createTenant, makeRunInStatus, type Tenant } from "./testing/fixtures";
import { createTestDatabase, type TestDatabase } from "./testing/testDb";

let t: TestDatabase;
let A: Tenant;
let B: Tenant;

beforeAll(async () => {
  t = await createTestDatabase();
  A = await createTenant(t.db, "alpha");
  B = await createTenant(t.db, "beta");
}, 30_000);
afterAll(async () => {
  await t.drop();
});

const request = (
  tenant: Tenant,
  prNumber: number,
  headSha: string,
  trigger: "pull_request" | "comment_command" = "pull_request",
) => ({
  repoId: tenant.repo.id,
  prNumber,
  headSha: headSha.padEnd(40, "0"),
  baseSha: "b".repeat(40),
  baseRef: "main",
  trigger,
  triggeredBy: "octocat",
});

describe("createRunSupersedingOlder", () => {
  it("creates a queued run when nothing else is active", async () => {
    const r = await createRunSupersedingOlder(t.db, A.installation.id, request(A, 1, "aaa"));
    expect(r.duplicate).toBe(false);
    expect(r.superseded).toEqual([]);
    expect(r.run.status).toBe("queued");
  });

  it("supersedes older queued and running runs of the same PR (PL-06, AC-15)", async () => {
    const id = A.installation.id;
    const queued = await makeRunInStatus(t.db, A, "queued", { prNumber: 2, headSha: "old1" });
    const running = await makeRunInStatus(t.db, A, "running", { prNumber: 2, headSha: "old2" });
    const done = await makeRunInStatus(t.db, A, "completed", { prNumber: 2, headSha: "old3" });

    const r = await createRunSupersedingOlder(t.db, id, request(A, 2, "new"));
    expect(r.superseded.map((x) => x.id).sort()).toEqual([queued.id, running.id].sort());
    for (const old of r.superseded) {
      expect(old.status).toBe("superseded");
      expect(old.finishedAt).not.toBeNull();
      expect(old.statusReason).toContain(r.run.id);
    }
    // Finished runs keep their status; only the new run is active.
    expect((await getRun(t.db, [id], done.id))?.status).toBe("completed");
    const active = await listRunsForPullRequest(t.db, [id], A.repo.id, 2, {
      status: ["queued", "running"],
    });
    expect(active.map((x) => x.id)).toEqual([r.run.id]);
  });

  it("leaves other pull requests and other repositories alone", async () => {
    const id = A.installation.id;
    const otherPr = await makeRunInStatus(t.db, A, "queued", { prNumber: 3 });
    const otherRepo = await makeRunInStatus(t.db, A, "queued", { prNumber: 4, repo: A.repo2 });
    await createRunSupersedingOlder(t.db, id, request(A, 4, "x"));
    expect((await getRun(t.db, [id], otherPr.id))?.status).toBe("queued");
    expect((await getRun(t.db, [id], otherRepo.id))?.status).toBe("queued");
  });

  it("is a no-op for an identical active run (same head SHA and trigger)", async () => {
    const id = A.installation.id;
    const first = await createRunSupersedingOlder(t.db, id, request(A, 5, "same"));
    const again = await createRunSupersedingOlder(t.db, id, request(A, 5, "same"));
    expect(again.duplicate).toBe(true);
    expect(again.run.id).toBe(first.run.id);
    expect(again.superseded).toEqual([]);
    expect(await listRunsForPullRequest(t.db, [id], A.repo.id, 5)).toHaveLength(1);
  });

  it("a different trigger on the same SHA is a new run that supersedes the old one", async () => {
    const id = A.installation.id;
    const auto = await createRunSupersedingOlder(t.db, id, request(A, 6, "same"));
    const manual = await createRunSupersedingOlder(
      t.db,
      id,
      request(A, 6, "same", "comment_command"),
    );
    expect(manual.duplicate).toBe(false);
    expect(manual.superseded.map((x) => x.id)).toEqual([auto.run.id]);
  });

  it("leaves exactly one active run when webhooks for the same PR race", async () => {
    const id = A.installation.id;
    const results = await Promise.all(
      Array.from({ length: 8 }, (_, i) =>
        createRunSupersedingOlder(t.db, id, request(A, 7, `sha${i}`)),
      ),
    );
    expect(results.every((r) => !r.duplicate)).toBe(true);
    const active = await listRunsForPullRequest(t.db, [id], A.repo.id, 7, {
      status: ["queued", "running"],
    });
    expect(active).toHaveLength(1);
    const all = await listRunsForPullRequest(t.db, [id], A.repo.id, 7);
    expect(all).toHaveLength(8);
    expect(all.filter((r) => r.status === "superseded")).toHaveLength(7);
  });

  it("links a re-run to its parent and refuses a foreign repository or parent", async () => {
    const id = A.installation.id;
    const parent = await makeRunInStatus(t.db, A, "completed", { prNumber: 8 });
    const r = await createRunSupersedingOlder(t.db, id, {
      ...request(A, 8, "re"),
      trigger: "comment_command",
      parentRunId: parent.id,
    });
    expect(r.run.parentRunId).toBe(parent.id);
    await expect(createRunSupersedingOlder(t.db, id, request(B, 8, "x"))).rejects.toBeInstanceOf(
      NotFoundError,
    );
    await expect(
      createRunSupersedingOlder(t.db, B.installation.id, {
        ...request(B, 9, "y"),
        parentRunId: parent.id,
      }),
    ).rejects.toBeInstanceOf(NotFoundError);
  });

  it("rejects an invalid pull request number before touching anything", async () => {
    await expect(
      createRunSupersedingOlder(t.db, A.installation.id, request(A, 0, "bad")),
    ).rejects.toBeInstanceOf(InvalidInputError);
  });
});

describe("repository helpers", () => {
  it("setAllRepositoriesActive deactivates and reactivates only that installation", async () => {
    expect(await setAllRepositoriesActive(t.db, B.installation.id, false)).toBe(2);
    expect(
      (await getRepositoryByGitHubId(t.db, [B.installation.id], B.repo.githubRepoId))?.active,
    ).toBe(false);
    expect(
      (await getRepositoryByGitHubId(t.db, [A.installation.id], A.repo.githubRepoId))?.active,
    ).toBe(true);
    expect(await setAllRepositoriesActive(t.db, B.installation.id, true)).toBe(2);
    expect(await setAllRepositoriesActive(t.db, "nope", true)).toBe(0);
  });

  it("upsertRepository without a default branch keeps the stored one (installation events)", async () => {
    const input = { githubRepoId: 777_001, fullName: "alpha/new", isPrivate: true };
    const created = await upsertRepository(t.db, A.installation.id, input);
    expect(created.defaultBranch).toBe("main");
    await upsertRepository(t.db, A.installation.id, {
      ...input,
      defaultBranch: "develop",
      fullName: "alpha/renamed",
    });
    const again = await upsertRepository(t.db, A.installation.id, input);
    expect(again.defaultBranch).toBe("develop");
    expect(again.fullName).toBe("alpha/new");
  });
});

describe("getRunByCheckRunId", () => {
  it("finds the run holding that Check Run", async () => {
    const run = await makeRunInStatus(t.db, A, "queued", { prNumber: 30 });
    await updateRunDetails(t.db, A.installation.id, run.id, { checkRunId: 4_242_424 });
    expect((await getRunByCheckRunId(t.db, [A.installation.id], 4_242_424))?.id).toBe(run.id);
    expect(await getRunByCheckRunId(t.db, [A.installation.id], 1)).toBeUndefined();
    expect(await getRunByCheckRunId(t.db, [A.installation.id], Number.NaN)).toBeUndefined();
  });
});

describe("reclaimFailedWebhookDelivery", () => {
  it("only a failed delivery can be reclaimed, and only once", async () => {
    await recordWebhookDelivery(t.db, { deliveryId: "d-ok", event: "pull_request" });
    await markWebhookDeliveryProcessed(t.db, "d-ok", "queued");
    await recordWebhookDelivery(t.db, { deliveryId: "d-fail", event: "pull_request" });
    await markWebhookDeliveryProcessed(t.db, "d-fail", "error");
    await recordWebhookDelivery(t.db, { deliveryId: "d-busy", event: "pull_request" });

    expect(await reclaimFailedWebhookDelivery(t.db, "d-ok")).toBe(false);
    expect(await reclaimFailedWebhookDelivery(t.db, "d-busy")).toBe(false);
    const racers = await Promise.all([
      reclaimFailedWebhookDelivery(t.db, "d-fail"),
      reclaimFailedWebhookDelivery(t.db, "d-fail"),
      reclaimFailedWebhookDelivery(t.db, "d-fail"),
    ]);
    expect(racers.filter(Boolean)).toHaveLength(1);
    expect((await getWebhookDelivery(t.db, "d-fail"))?.outcome).toBeNull();
    expect(await reclaimFailedWebhookDelivery(t.db, "unknown")).toBe(false);
  });
});
