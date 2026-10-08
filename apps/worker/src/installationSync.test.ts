// The scheduled reconciliation with GitHub (design §16, AC-22): repositories that GitHub lists and we do not hold are
// added, ones we hold that GitHub no longer lists are deactivated, and an installation GitHub no longer knows goes
// through the uninstall flow. Real PostgreSQL, a scripted GitHub.
import { listRepositories, putProviderCredential } from "@ai-pr-review/db";
import { getRunById } from "@ai-pr-review/db/system";
import {
  createTenant,
  createTestDatabase,
  makeRun,
  type TestDatabase,
} from "@ai-pr-review/db/testing";
import { InMemoryRunSignals } from "@ai-pr-review/queue";
import { createLogger } from "@ai-pr-review/shared";
import { afterAll, beforeEach, beforeAll, describe, expect, it } from "vitest";
import { InstallationGoneError, InstallationSync, type RemoteRepository } from "./installationSync";

let t: TestDatabase;
let signals: InMemoryRunSignals;
let lines: string[];

beforeAll(async () => {
  t = await createTestDatabase();
}, 60_000);
afterAll(async () => {
  await t.drop();
});
beforeEach(async () => {
  signals = new InMemoryRunSignals();
  lines = [];
  // The sync looks at every active installation in the database: leave only this test's own.
  await t.pool.query("update installations set status = 'suspended'");
});

type Remote = Record<number, RemoteRepository[] | "gone" | Error>;

const syncWith = (remote: Remote) =>
  new InstallationSync({
    db: t.db,
    signals,
    logger: createLogger({}, (line) => lines.push(line)),
    listRemoteRepositories: async (githubInstallationId) => {
      const answer = remote[githubInstallationId];
      if (answer === "gone") throw new InstallationGoneError();
      if (answer instanceof Error) throw answer;
      return answer ?? [];
    },
  });

const remoteOf = (tenant: Awaited<ReturnType<typeof createTenant>>): RemoteRepository[] =>
  [tenant.repo, tenant.repo2].map((r) => ({
    id: r.githubRepoId,
    fullName: r.fullName,
    isPrivate: r.isPrivate,
    defaultBranch: "main",
  }));

describe("repositories", () => {
  it("adds a repository GitHub lists and we do not know, deactivates one GitHub no longer lists, reactivates one that came back", async () => {
    const tenant = await createTenant(t.db, "sync-repos");
    const gh = tenant.installation.githubInstallationId;
    // A removed repository we still hold as active (the "removed" webhook was lost), a new one we never heard of.
    const newRepo = {
      id: 999_000_111,
      fullName: `${tenant.installation.accountLogin}/new`,
      isPrivate: true,
      defaultBranch: "develop",
    };
    const result = await syncWith({ [gh]: [remoteOf(tenant)[0]!, newRepo] }).syncOnce();

    expect(result).toMatchObject({ added: 1, removed: 1, uninstalled: 0 });
    const all = await listRepositories(t.db, [tenant.installation.id], {});
    const byId = new Map(all.map((r) => [r.githubRepoId, r]));
    expect(byId.get(tenant.repo.githubRepoId)?.active).toBe(true);
    expect(byId.get(tenant.repo2.githubRepoId)?.active).toBe(false);
    expect(byId.get(newRepo.id)).toMatchObject({
      active: true,
      defaultBranch: "develop",
      fullName: newRepo.fullName,
    });

    // It came back on GitHub: reactivated, and the admin's `enabled` choice is untouched.
    const again = await syncWith({ [gh]: [...remoteOf(tenant), newRepo] }).syncOnce();
    expect(again).toMatchObject({ added: 1, removed: 0 });
    expect(await listRepositories(t.db, [tenant.installation.id], { active: true })).toHaveLength(
      3,
    );
  });

  it("changes nothing when GitHub and the database agree, and says nothing", async () => {
    const tenant = await createTenant(t.db, "sync-same");
    const result = await syncWith({
      [tenant.installation.githubInstallationId]: remoteOf(tenant),
    }).syncOnce();
    expect(result).toMatchObject({ added: 0, removed: 0, uninstalled: 0, failed: 0 });
    expect(lines.join("\n")).not.toContain("corrected differences");
  });

  it("a failure for one installation does not stop the others, and the error text is never logged", async () => {
    const broken = await createTenant(t.db, "sync-broken");
    const fine = await createTenant(t.db, "sync-fine");
    const result = await syncWith({
      [broken.installation.githubInstallationId]: new Error("token ghp_secret in the message"),
      [fine.installation.githubInstallationId]: remoteOf(fine).slice(0, 1),
    }).syncOnce();
    expect(result.failed).toBeGreaterThanOrEqual(1);
    expect(await listRepositories(t.db, [fine.installation.id], { active: true })).toHaveLength(1);
    expect(await listRepositories(t.db, [broken.installation.id], { active: true })).toHaveLength(
      2,
    );
    expect(lines.join("\n")).not.toContain("ghp_secret");
  });
});

describe("an installation GitHub no longer knows", () => {
  it("runs the uninstall flow: status, queued runs cancelled and announced, keys and access deleted", async () => {
    // Enough healthy installations around it that this one stands out as the exception.
    const others = await Promise.all([1, 2, 3].map((n) => createTenant(t.db, `sync-ok-${n}`)));
    const lost = await createTenant(t.db, "sync-lost");
    const queued = await makeRun(t.db, lost);
    await putProviderCredential(t.db, lost.installation.id, {
      provider: "deepseek",
      ciphertext: Buffer.from("sealed"),
      keyVersion: 1,
      last4: "abcd",
    });
    const remote: Remote = { [lost.installation.githubInstallationId]: "gone" };
    for (const other of others) remote[other.installation.githubInstallationId] = remoteOf(other);

    const result = await syncWith(remote).syncOnce();

    expect(result.uninstalled).toBe(1);
    expect(
      (await t.pool.query("select status from installations where id = $1", [lost.installation.id]))
        .rows[0].status,
    ).toBe("deleted");
    expect(await getRunById(t.db, queued.id)).toMatchObject({ status: "cancelled" });
    expect(signals.cancelled.map((c) => c.runId)).toEqual([queued.id]);
    expect(signals.updated.map((u) => u.status)).toEqual(["cancelled"]);
    expect(
      (
        await t.pool.query(
          "select count(*)::int as n from provider_credentials where installation_id = $1",
          [lost.installation.id],
        )
      ).rows[0].n,
    ).toBe(0);
    expect(lines.join("\n")).toContain("uninstalled on GitHub without a webhook");
    // The others were not touched.
    for (const other of others) {
      expect(
        (
          await t.pool.query("select status from installations where id = $1", [
            other.installation.id,
          ])
        ).rows[0].status,
      ).toBe("active");
    }
  });

  it("does not act when most installations look gone at once: that is a misconfiguration, not a wave of uninstalls", async () => {
    // Make the earlier tests' installations irrelevant: only these remain active.
    await t.pool.query("update installations set status = 'suspended'");
    const tenants = await Promise.all(
      [1, 2, 3, 4].map((n) => createTenant(t.db, `sync-wrong-app-${n}`)),
    );
    const remote: Remote = {};
    for (const tenant of tenants) remote[tenant.installation.githubInstallationId] = "gone";

    const result = await syncWith(remote).syncOnce();

    expect(result.uninstalled).toBe(0);
    expect(result.failed).toBe(4);
    const rows = await t.pool.query("select status from installations where id = any($1)", [
      tenants.map((x) => x.installation.id),
    ]);
    expect(rows.rows.every((r) => r.status === "active")).toBe(true);
    expect(lines.join("\n")).toContain("not acting on it");
    expect(lines.join("\n")).toContain("GITHUB_APP_ID");
  });
});

describe("scheduling", () => {
  it("starts after one interval, not at start-up, and stops when told to", async () => {
    const { vi } = await import("vitest");
    vi.useFakeTimers();
    try {
      const sync = syncWith({});
      const pass = vi
        .spyOn(sync, "syncOnce")
        .mockResolvedValue({ installations: 0, added: 0, removed: 0, uninstalled: 0, failed: 0 });
      sync.start(60_000);
      expect(pass).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(60_000);
      expect(pass).toHaveBeenCalledTimes(1);
      sync.stop();
      await vi.advanceTimersByTimeAsync(120_000);
      expect(pass).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });
});
