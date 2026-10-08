// Role mapping and the access cache (PL-13): roles come from GitHub, are cached briefly and are re-checked on
// demand with the App's installation token; whatever cannot be verified fails closed.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { installationRoleFor } from "./access";
import {
  createHarness,
  createWorld,
  type Harness,
  type Session,
  type World,
} from "../testing/harness";

const MINUTE = 60_000;

describe("installationRoleFor", () => {
  it("makes the owner of a personal account admin, other users viewers", () => {
    const account = { login: "octocat", type: "user" as const };
    expect(installationRoleFor(account, { login: "octocat" }, undefined)).toBe("admin");
    expect(installationRoleFor(account, { login: "OctoCat" }, undefined)).toBe("admin");
    expect(installationRoleFor(account, { login: "hubot" }, undefined)).toBe("viewer");
  });

  it("makes organisation owners admin and everyone else, or anyone GitHub will not tell us about, a viewer", () => {
    const account = { login: "acme", type: "organization" as const };
    expect(installationRoleFor(account, { login: "x" }, "admin")).toBe("admin");
    for (const role of ["member", "none", "unknown", undefined] as const) {
      expect(installationRoleFor(account, { login: "x" }, role)).toBe("viewer");
    }
    // Having the organisation's name as a login does not make a user its owner.
    expect(installationRoleFor(account, { login: "acme" }, "member")).toBe("viewer");
  });
});

let h: Harness;
let world: World;
let alice: Session;
let victor: Session;

beforeEach(async () => {
  h = await createHarness();
  world = await createWorld(h);
  alice = await h.signIn(world.alice);
  victor = await h.signIn(world.victor);
}, 60_000);
afterEach(async () => {
  await h.close();
});

const repoUrl = (repo = world.alpha.repo) => `/api/repos/${repo.id}`;
const get = (s: Session, url: string) => h.request(s, "GET", url);
const patchSettings = (s: Session, repo = world.alpha.repo) =>
  h.request(s, "PATCH", `${repoUrl(repo)}/settings`, {
    body: { config: { review: { mode: "warn" } } },
  });

describe("the cache", () => {
  it("is used without asking GitHub while it is fresh", async () => {
    const calls = h.github.appCalls;
    h.clock.advance(5 * MINUTE);
    expect((await get(victor, repoUrl())).statusCode).toBe(200);
    expect((await get(victor, "/api/repos")).statusCode).toBe(200);
    expect(h.github.appCalls).toBe(calls);
  });

  it("is re-verified once it is older than the TTL, then fresh again", async () => {
    h.clock.advance(11 * MINUTE);
    const before = h.github.appCalls;
    expect((await get(victor, repoUrl())).statusCode).toBe(200);
    expect(h.github.appCalls).toBe(before + 1);
    expect((await get(victor, repoUrl())).statusCode).toBe(200);
    expect(h.github.appCalls).toBe(before + 1);
  });

  it("picks up a promotion on GitHub without a new sign-in", async () => {
    expect((await patchSettings(victor)).statusCode).toBe(403);
    h.github.repoPermissions.set(`victor|${world.alpha.repo.fullName}`, "admin");
    // Still the old role inside the TTL...
    expect((await patchSettings(victor)).statusCode).toBe(403);
    h.clock.advance(11 * MINUTE);
    // ...and the new one afterwards. Only that repository changes.
    expect((await patchSettings(victor)).statusCode).toBe(200);
    expect((await patchSettings(victor, world.alpha.repo2)).statusCode).toBe(403);
    expect((await get(victor, repoUrl())).json().role).toBe("admin");
  });

  it("drops access that GitHub no longer grants: 404, and the cache entry is gone", async () => {
    h.github.repoPermissions.set(`victor|${world.alpha.repo.fullName}`, "none");
    h.clock.advance(11 * MINUTE);
    expect((await get(victor, repoUrl())).statusCode).toBe(404);
    expect((await get(victor, `${repoUrl()}/settings`)).statusCode).toBe(404);
    const rows = await h.t.pool.query(
      "select 1 from user_repositories where user_id = $1 and repo_id = $2",
      [victor.userId, world.alpha.repo.id],
    );
    expect(rows.rowCount).toBe(0);
    // The repository they still have is untouched, and so is the list.
    expect((await get(victor, repoUrl(world.alpha.repo2))).statusCode).toBe(200);
    const names = (await get(victor, "/api/repos"))
      .json()
      .items.map((r: { full_name: string }) => r.full_name);
    expect(names).toEqual([world.alpha.repo2.fullName]);
  });

  it("fails closed when GitHub cannot be asked: 503 for a repository, nothing listed, never stale access", async () => {
    h.github.unavailable = true;
    h.clock.advance(11 * MINUTE);
    const res = await get(victor, repoUrl());
    expect(res.statusCode).toBe(503);
    expect(res.json().error.code).toBe("access_check_failed");
    const list = await get(victor, "/api/repos");
    expect(list.statusCode).toBe(200);
    expect(list.json().items).toEqual([]);

    h.github.unavailable = false;
    expect((await get(victor, repoUrl())).statusCode).toBe(200);
    expect((await get(victor, "/api/repos")).json().items).toHaveLength(2);
  });

  it("does not let a fresh entry mask an outage: only stale entries need GitHub", async () => {
    h.github.unavailable = true;
    expect((await get(victor, repoUrl())).statusCode).toBe(200);
  });
});

describe("installation admin", () => {
  const installationSettings = (s: Session) =>
    h.request(s, "PATCH", `/api/installations/${world.alpha.installation.id}/settings`, {
      body: { config: { review: { mode: "warn" } } },
    });

  it("is kept while GitHub still says the user owns the organisation", async () => {
    h.clock.advance(11 * MINUTE);
    expect((await installationSettings(alice)).statusCode).toBe(200);
  });

  it("is lost when the user stops being an owner, while repository admin rights follow their own permission", async () => {
    expect((await installationSettings(alice)).statusCode).toBe(200);
    h.github.orgRoles.set(`alice|${world.alpha.installation.accountLogin}`, "member");
    h.clock.advance(11 * MINUTE);
    expect((await installationSettings(alice)).statusCode).toBe(403);
    const me = (await get(alice, "/api/me")).json();
    expect(me.installations[0].role).toBe("viewer");
    // GitHub still lists alice as admin of the repository.
    expect((await patchSettings(alice)).statusCode).toBe(200);
  });

  it("falls to viewer, not to locked out, when GitHub cannot say", async () => {
    h.github.orgRoles.set(`alice|${world.alpha.installation.accountLogin}`, "unknown");
    h.clock.advance(11 * MINUTE);
    expect((await installationSettings(alice)).statusCode).toBe(403);
    expect((await get(alice, "/api/me")).statusCode).toBe(200);
  });

  it("an outage is a 503 for admin-only installation actions, never a silent admin", async () => {
    h.github.unavailable = true;
    h.clock.advance(11 * MINUTE);
    expect((await installationSettings(alice)).statusCode).toBe(503);
  });
});

describe("login refresh", () => {
  it("without the organisation Members permission: viewer on the installation, repository admin from GitHub's permission", async () => {
    h.github.users.set("dana", {
      id: 4242,
      login: "dana",
      installations: [
        {
          id: world.alpha.installation.githubInstallationId,
          accountLogin: world.alpha.installation.accountLogin,
          accountType: "organization",
          orgRole: "unknown",
          repos: [
            { id: world.alpha.repo.githubRepoId, fullName: world.alpha.repo.fullName, admin: true },
            {
              id: world.alpha.repo2.githubRepoId,
              fullName: world.alpha.repo2.fullName,
              admin: false,
            },
          ],
        },
      ],
    });
    const dana = await h.signIn("dana");
    expect((await get(dana, "/api/me")).json().installations[0].role).toBe("viewer");
    expect((await get(dana, repoUrl())).json().role).toBe("admin");
    expect((await get(dana, repoUrl(world.alpha.repo2))).json().role).toBe("viewer");
  });

  it("only offers repositories GitHub lists for the user, not every repository of the installation", async () => {
    h.github.users.get("victor")!.installations[0]!.repos.pop();
    const fresh = await h.signIn("victor");
    expect((await get(fresh, repoUrl())).statusCode).toBe(200);
    expect((await get(fresh, repoUrl(world.alpha.repo2))).statusCode).toBe(404);
  });

  it("replaces the old cache: access GitHub no longer reports is removed at the next sign-in", async () => {
    h.github.users.get("victor")!.installations = [];
    const fresh = await h.signIn("victor");
    expect((await get(fresh, "/api/repos")).json().items).toEqual([]);
    expect((await get(fresh, "/api/me")).json().installations).toEqual([]);
    expect((await get(fresh, repoUrl())).statusCode).toBe(404);
  });

  it("ignores installations and repositories this platform has not seen (their webhook has not arrived)", async () => {
    h.github.users.get("victor")!.installations.push({
      id: 999_999_999,
      accountLogin: "unknown-org",
      accountType: "organization",
      orgRole: "admin",
      repos: [{ id: 1, fullName: "unknown-org/x", admin: true }],
    });
    h.github.users.get("victor")!.installations[0]!.repos.push({
      id: 888_888_888,
      fullName: "alpha/not-yet-known",
      admin: true,
    });
    const fresh = await h.signIn("victor");
    const me = (await get(fresh, "/api/me")).json();
    expect(me.installations.map((i: { account_login: string }) => i.account_login)).toEqual([
      world.alpha.installation.accountLogin,
    ]);
    expect((await get(fresh, "/api/repos")).json().items).toHaveLength(2);
  });
});
