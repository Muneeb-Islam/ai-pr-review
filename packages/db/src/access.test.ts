// Phase 4 system functions against a real PostgreSQL: sessions and the user access cache.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createSession,
  deleteExpiredSessions,
  deleteSession,
  deleteUserSessions,
  getRepositoryById,
  getSessionWithUser,
  getUserInstallationAccess,
  getUserRepoAccess,
  listAccessibleInstallationIds,
  listUserInstallationAccess,
  listUserRepoAccess,
  replaceUserAccess,
  setInstallationStatus,
  setUserInstallationRole,
  setUserRepoAccess,
  touchSession,
  upsertUser,
} from "./system";
import { setAllRepositoriesActive, setRepositoriesActive } from "./tenant";
import { createTenant, type Tenant } from "./testing/fixtures";
import { createTestDatabase, type TestDatabase } from "./testing/testDb";

let t: TestDatabase;
let alpha: Tenant;
let beta: Tenant;

beforeAll(async () => {
  t = await createTestDatabase();
  alpha = await createTenant(t.db, "alpha");
  beta = await createTenant(t.db, "beta");
}, 60_000);
afterAll(async () => {
  await t.drop();
});

const HOUR = 3_600_000;

describe("sessions", () => {
  it("creates, loads with the user, touches and deletes a session", async () => {
    const now = new Date("2026-10-02T10:00:00.000Z");
    const session = await createSession(t.db, {
      userId: alpha.user.id,
      csrfSecret: "secret",
      expiresAt: new Date(now.getTime() + 24 * HOUR),
      now,
    });
    expect(session.lastSeenAt).toEqual(now);

    const found = await getSessionWithUser(t.db, session.id);
    expect(found?.user.id).toBe(alpha.user.id);
    expect(found?.session.csrfSecret).toBe("secret");

    const later = new Date(now.getTime() + HOUR);
    await touchSession(t.db, session.id, later);
    expect((await getSessionWithUser(t.db, session.id))?.session.lastSeenAt).toEqual(later);

    await deleteSession(t.db, session.id);
    expect(await getSessionWithUser(t.db, session.id)).toBeUndefined();
  });

  it("treats malformed ids as unknown instead of failing in the database", async () => {
    expect(await getSessionWithUser(t.db, "nope")).toBeUndefined();
    await expect(deleteSession(t.db, "nope")).resolves.toBeUndefined();
    await expect(touchSession(t.db, "nope", new Date())).resolves.toBeUndefined();
    expect(await deleteUserSessions(t.db, "nope")).toBe(0);
  });

  it("ends every session of a user except the one kept", async () => {
    const user = await upsertUser(t.db, { githubUserId: 777_001, login: "multi" });
    const make = () =>
      createSession(t.db, {
        userId: user.id,
        csrfSecret: "s",
        expiresAt: new Date(Date.now() + HOUR),
      });
    const [a, b, c] = [await make(), await make(), await make()];
    expect(await deleteUserSessions(t.db, user.id, a.id)).toBe(2);
    expect(await getSessionWithUser(t.db, a.id)).toBeDefined();
    expect(await getSessionWithUser(t.db, b.id)).toBeUndefined();
    expect(await getSessionWithUser(t.db, c.id)).toBeUndefined();
  });

  it("sweeps sessions past their absolute end or idle for too long, keeps the rest", async () => {
    const user = await upsertUser(t.db, { githubUserId: 777_002, login: "sweep" });
    const now = new Date("2026-10-02T12:00:00.000Z");
    const make = (expiresInH: number, seenAgoH: number) =>
      createSession(t.db, {
        userId: user.id,
        csrfSecret: "s",
        expiresAt: new Date(now.getTime() + expiresInH * HOUR),
        now: new Date(now.getTime() - seenAgoH * HOUR),
      });
    const live = await make(24, 1);
    const expired = await make(-1, 0);
    const idle = await make(24, 3);

    const removed = await deleteExpiredSessions(t.db, 2 * HOUR, now);
    expect(removed).toBeGreaterThanOrEqual(2);
    expect(await getSessionWithUser(t.db, live.id)).toBeDefined();
    expect(await getSessionWithUser(t.db, expired.id)).toBeUndefined();
    expect(await getSessionWithUser(t.db, idle.id)).toBeUndefined();
  });
});

describe("user access cache", () => {
  it("replaces installations and repositories, removing what is no longer reported", async () => {
    const at = new Date("2026-10-02T10:00:00.000Z");
    await replaceUserAccess(
      t.db,
      alpha.user.id,
      {
        installations: [
          { installationId: alpha.installation.id, role: "admin" },
          { installationId: beta.installation.id, role: "viewer" },
        ],
        repositories: [
          { installationId: alpha.installation.id, repoId: alpha.repo.id, role: "admin" },
          { installationId: alpha.installation.id, repoId: alpha.repo2.id, role: "viewer" },
          { installationId: beta.installation.id, repoId: beta.repo.id, role: "viewer" },
        ],
      },
      at,
    );
    expect(
      (await listUserInstallationAccess(t.db, alpha.user.id)).map((i) => i.role).sort(),
    ).toEqual(["admin", "viewer"]);
    expect(await listUserRepoAccess(t.db, alpha.user.id)).toHaveLength(3);

    await replaceUserAccess(t.db, alpha.user.id, {
      installations: [{ installationId: alpha.installation.id, role: "viewer" }],
      repositories: [
        { installationId: alpha.installation.id, repoId: alpha.repo.id, role: "viewer" },
      ],
    });
    expect(await listAccessibleInstallationIds(t.db, alpha.user.id)).toEqual([
      alpha.installation.id,
    ]);
    const repos = await listUserRepoAccess(t.db, alpha.user.id);
    expect(repos.map((r) => [r.repoId, r.role])).toEqual([[alpha.repo.id, "viewer"]]);

    await replaceUserAccess(t.db, alpha.user.id, { installations: [], repositories: [] });
    expect(await listUserRepoAccess(t.db, alpha.user.id)).toEqual([]);
    expect(await listUserInstallationAccess(t.db, alpha.user.id)).toEqual([]);
  });

  it("returns access to one repository with its GitHub coordinates, and only while everything is active", async () => {
    await replaceUserAccess(t.db, alpha.user.id, {
      installations: [{ installationId: alpha.installation.id, role: "admin" }],
      repositories: [
        { installationId: alpha.installation.id, repoId: alpha.repo.id, role: "admin" },
      ],
    });
    const access = await getUserRepoAccess(t.db, alpha.user.id, alpha.repo.id);
    expect(access).toMatchObject({
      repoId: alpha.repo.id,
      installationId: alpha.installation.id,
      githubInstallationId: alpha.installation.githubInstallationId,
      fullName: alpha.repo.fullName,
      role: "admin",
    });

    // Repository removed from the installation on GitHub.
    await setRepositoriesActive(t.db, alpha.installation.id, [alpha.repo.githubRepoId], false);
    expect(await getUserRepoAccess(t.db, alpha.user.id, alpha.repo.id)).toBeUndefined();
    expect(await listUserRepoAccess(t.db, alpha.user.id)).toEqual([]);
    await setAllRepositoriesActive(t.db, alpha.installation.id, true);
    expect(await getUserRepoAccess(t.db, alpha.user.id, alpha.repo.id)).toBeDefined();

    // Installation suspended or uninstalled (AC-22).
    await setInstallationStatus(t.db, alpha.installation.githubInstallationId, "suspended");
    expect(await getUserRepoAccess(t.db, alpha.user.id, alpha.repo.id)).toBeUndefined();
    expect(
      await getUserInstallationAccess(t.db, alpha.user.id, alpha.installation.id),
    ).toBeUndefined();
    expect(await listAccessibleInstallationIds(t.db, alpha.user.id)).toEqual([]);
    await setInstallationStatus(t.db, alpha.installation.githubInstallationId, "active");
    expect(await getUserRepoAccess(t.db, alpha.user.id, alpha.repo.id)).toBeDefined();
  });

  it("repository access without the installation row is no access", async () => {
    await setUserInstallationRole(t.db, alpha.user.id, alpha.installation.id, null);
    expect(await getUserRepoAccess(t.db, alpha.user.id, alpha.repo.id)).toBeUndefined();
    // Removing the installation removed its repositories from the cache too.
    expect(await listUserRepoAccess(t.db, alpha.user.id)).toEqual([]);
  });

  it("updates and removes a single repository entry on demand", async () => {
    await setUserInstallationRole(t.db, alpha.user.id, alpha.installation.id, "viewer");
    await setUserRepoAccess(t.db, alpha.user.id, alpha.installation.id, alpha.repo.id, "viewer");
    expect((await getUserRepoAccess(t.db, alpha.user.id, alpha.repo.id))?.role).toBe("viewer");
    const at = new Date("2030-01-01T00:00:00.000Z");
    await setUserRepoAccess(t.db, alpha.user.id, alpha.installation.id, alpha.repo.id, "admin", at);
    const access = await getUserRepoAccess(t.db, alpha.user.id, alpha.repo.id);
    expect(access?.role).toBe("admin");
    expect(access?.refreshedAt).toEqual(at);
    await setUserRepoAccess(t.db, alpha.user.id, alpha.installation.id, alpha.repo.id, null);
    expect(await getUserRepoAccess(t.db, alpha.user.id, alpha.repo.id)).toBeUndefined();
  });

  it("the database refuses a repository entry whose installation is not the repository's", async () => {
    await expect(
      setUserRepoAccess(t.db, alpha.user.id, beta.installation.id, alpha.repo.id, "admin"),
    ).rejects.toMatchObject({ cause: { code: "23503" } });
  });

  it("treats malformed ids as no access", async () => {
    expect(await getUserRepoAccess(t.db, "nope", alpha.repo.id)).toBeUndefined();
    expect(await getUserRepoAccess(t.db, alpha.user.id, "nope")).toBeUndefined();
    expect(await getUserInstallationAccess(t.db, alpha.user.id, "nope")).toBeUndefined();
    expect(await listUserRepoAccess(t.db, "nope")).toEqual([]);
    expect(await listUserInstallationAccess(t.db, "nope")).toEqual([]);
    expect(await getRepositoryById(t.db, "nope")).toBeUndefined();
  });

  it("removing a user removes their sessions and cached access (cascade)", async () => {
    const user = await upsertUser(t.db, { githubUserId: 777_003, login: "leaving" });
    await createSession(t.db, {
      userId: user.id,
      csrfSecret: "s",
      expiresAt: new Date(Date.now() + HOUR),
    });
    await replaceUserAccess(t.db, user.id, {
      installations: [{ installationId: alpha.installation.id, role: "viewer" }],
      repositories: [
        { installationId: alpha.installation.id, repoId: alpha.repo.id, role: "viewer" },
      ],
    });
    await t.pool.query("delete from users where id = $1", [user.id]);
    for (const table of ["sessions", "user_installations", "user_repositories"]) {
      const rows = await t.pool.query(`select 1 from ${table} where user_id = $1`, [user.id]);
      expect(rows.rowCount, table).toBe(0);
    }
  });
});
