// Authorisation matrix for every endpoint in the contract (AC-17, PL-13): anonymous, a user of another
// tenant, a user with no installation at all, a viewer and an admin. Cross-tenant access is a 404 (no
// existence leak); too little role is a 403; mutations without a CSRF token are refused.
import { listAuditLog } from "@ai-pr-review/db";
import { setInstallationStatus } from "@ai-pr-review/db/system";
import { makeFullRun, makeRun } from "@ai-pr-review/db/testing";
import { endpoints, type EndpointDef, type EndpointName } from "@ai-pr-review/shared";
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
let victor: Session;
let bob: Session;
let carol: Session;
let alphaRunId: string;
/** Cancel needs a run that is still active, and re-run supersedes the other active runs of its pull request. */
let cancelRunId: string;
/** A reviewed pull request of alpha's first repository with a posted finding, for the history and feedback routes. */
let reviewed: Awaited<ReturnType<typeof makeFullRun>>;

beforeAll(async () => {
  h = await createHarness();
  world = await createWorld(h);
  alphaRunId = (await makeRun(h.t.db, world.alpha, { repo: world.alpha.repo2 })).id;
  cancelRunId = (await makeRun(h.t.db, world.alpha, { repo: world.alpha.repo2 })).id;
  reviewed = await makeFullRun(h.t.db, world.alpha);
  [alice, victor, bob, carol] = await Promise.all([
    h.signIn(world.alice),
    h.signIn(world.victor),
    h.signIn(world.bob),
    h.signIn(world.carol),
  ]);
}, 60_000);
afterAll(async () => {
  await h.close();
});

const KEY = "sk-matrix-0123456789abcd";

/** A valid request for each endpoint against alpha's resources. */
function requestFor(name: EndpointName): { method: string; url: string; body?: unknown } {
  const def: EndpointDef = endpoints[name];
  const id =
    def.resource === "installation"
      ? world.alpha.installation.id
      : def.resource === "run"
        ? name === "cancelRun"
          ? cancelRunId
          : alphaRunId
        : def.resource === "finding"
          ? reviewed.finding.id
          : world.alpha.repo.id;
  let url = def.path.replace(":id", id).replace(":number", String(reviewed.run.prNumber));
  if ("query" in def && name.startsWith("delete")) url += "?provider=deepseek";
  if (name === "exportCsv") url += "?kind=runs";
  const body =
    name === "patchRepoSettings"
      ? { config: { review: { mode: "warn" } } }
      : name === "patchInstallationSettings"
        ? { config: { review: { max_inline_comments: 10 } } }
        : name === "giveFeedback"
          ? { verdict: "useful", note: "Matches what we saw" }
          : "body" in def
            ? { provider: "deepseek", api_key: KEY }
            : undefined;
  return { method: def.method, url, ...(body !== undefined ? { body } : {}) };
}

const send = (session: Session | undefined, name: EndpointName, extra: { csrf?: boolean } = {}) => {
  const r = requestFor(name);
  return h.request(session, r.method as "GET", r.url, {
    ...(r.body !== undefined ? { body: r.body } : {}),
    ...extra,
  });
};

const resourceEndpoints = (Object.keys(endpoints) as EndpointName[]).filter(
  (n) => "resource" in endpoints[n],
);

describe("the contract", () => {
  it("declares access for every route that takes an :id (an endpoint cannot forget its check)", () => {
    for (const name of Object.keys(endpoints) as EndpointName[]) {
      const def: EndpointDef = endpoints[name];
      if (def.path.includes(":id")) {
        expect(def, name).toHaveProperty("resource");
        expect(def.auth, name).toBe("session");
      }
    }
  });

  it("only the OAuth navigations are public", () => {
    const publicOnes = (Object.keys(endpoints) as EndpointName[]).filter(
      (n) => endpoints[n].auth === "none",
    );
    expect(publicOnes.sort()).toEqual(["login", "loginCallback"]);
  });

  it("requires admin for every write (feedback aside) and for everything about credentials", () => {
    for (const name of Object.keys(endpoints) as EndpointName[]) {
      const def: EndpointDef = endpoints[name];
      if (!def.resource) continue;
      // Anyone who can see a finding may say whether it was useful: that is a vote, not a change of settings.
      const writes = def.method !== "GET" && name !== "giveFeedback";
      const credentials = def.path.includes("/credentials");
      if (writes || credentials) expect(def.role, name).toBe("admin");
      if (name === "giveFeedback") expect(def.role).toBeUndefined();
    }
  });
});

describe.each(resourceEndpoints)("%s", (name) => {
  const admin = "role" in endpoints[name] && endpoints[name].role === "admin";

  it("anonymous: 401", async () => {
    const res = await send(undefined, name);
    expect(res.statusCode).toBe(401);
    expect(res.json().error.code).toBe("unauthorized");
  });

  it("a user with no installation: 404", async () => {
    const res = await send(carol, name);
    expect(res.statusCode).toBe(404);
    expect(res.json().error.code).toBe("not_found");
  });

  it("a user of another tenant: 404, identical to a resource that does not exist", async () => {
    const foreign = await send(bob, name);
    expect(foreign.statusCode).toBe(404);

    const def = endpoints[name];
    const missingId = "00000000-0000-4000-8000-000000000000";
    const missing = await h.request(
      bob,
      def.method as "GET",
      requestFor(name).url.replace(/[0-9a-f-]{36}/, missingId),
      {
        ...("body" in def ? { body: requestFor(name).body } : {}),
      },
    );
    expect(missing.statusCode).toBe(404);
    // Same body: nothing tells "exists but not yours" from "does not exist" (request ids differ).
    const strip = (r: typeof foreign) => {
      const { error } = r.json();
      return { code: error.code, message: error.message };
    };
    expect(strip(foreign)).toEqual(strip(missing));
  });

  it(admin ? "a viewer: 403" : "a viewer: allowed", async () => {
    const res = await send(victor, name);
    if (admin) {
      expect(res.statusCode).toBe(403);
      expect(res.json().error.code).toBe("forbidden");
    } else {
      expect(res.statusCode).toBe(200);
    }
  });

  it("a mutation without the CSRF token: 403 even for an admin", async () => {
    if (endpoints[name].method === "GET") return;
    const res = await send(alice, name, { csrf: false });
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe("csrf_invalid");
  });

  it("an admin: allowed", async () => {
    const res = await send(alice, name);
    expect(res.statusCode, res.body).toBe(
      ("status" in endpoints[name] && endpoints[name].status) || 200,
    );
  });
});

describe("after the matrix", () => {
  it("only the admin's actions left a mark: nobody else changed settings or credentials", async () => {
    const log = await listAuditLog(h.t.db, [world.alpha.installation.id], { limit: 100 });
    expect(log.items.length).toBeGreaterThan(0);
    expect(new Set(log.items.map((e) => e.userId))).toEqual(new Set([alice.userId]));
    // Beta has no entries at all: bob's requests against alpha never touched his own tenant either.
    expect((await listAuditLog(h.t.db, [world.beta.installation.id])).items).toEqual([]);
  });
});

describe("GET /api/repos and GET /api/repos/:id", () => {
  const names = async (s: Session) =>
    ((await h.request(s, "GET", "/api/repos")).json().items as Array<{ full_name: string }>)
      .map((r) => r.full_name)
      .sort();

  it("each user sees only the repositories of their own installation", async () => {
    const alphaNames = [world.alpha.repo.fullName, world.alpha.repo2.fullName].sort();
    expect(await names(alice)).toEqual(alphaNames);
    expect(await names(victor)).toEqual(alphaNames);
    expect(await names(bob)).toEqual([world.beta.repo.fullName, world.beta.repo2.fullName].sort());
    expect(await names(carol)).toEqual([]);
  });

  it("reports the caller's role per repository", async () => {
    const body = (await h.request(victor, "GET", "/api/repos")).json();
    expect(body.items.every((r: { role: string }) => r.role === "viewer")).toBe(true);
    const mine = (await h.request(alice, "GET", "/api/repos")).json();
    expect(mine.items.every((r: { role: string }) => r.role === "admin")).toBe(true);
  });

  it("filters by search without widening the scope", async () => {
    const res = await h.request(alice, "GET", `/api/repos?search=${encodeURIComponent("beta")}`);
    expect(res.json().items).toEqual([]);
    const own = await h.request(alice, "GET", "/api/repos?search=api");
    expect(own.json().items).toHaveLength(1);
  });

  it("ignores an installation_id filter that is not the caller's", async () => {
    const res = await h.request(
      alice,
      "GET",
      `/api/repos?installation_id=${world.beta.installation.id}`,
    );
    expect(res.statusCode).toBe(200);
    expect(res.json().items).toEqual([]);
  });

  it("returns one repository to someone who can see it and 404 to everyone else", async () => {
    const url = `/api/repos/${world.alpha.repo.id}`;
    const ok = await h.request(victor, "GET", url);
    expect(ok.statusCode).toBe(200);
    expect(ok.json()).toMatchObject({ id: world.alpha.repo.id, role: "viewer" });
    expect((await h.request(bob, "GET", url)).statusCode).toBe(404);
    expect((await h.request(carol, "GET", url)).statusCode).toBe(404);
    expect((await h.request(alice, "GET", "/api/repos/not-a-uuid")).statusCode).toBe(404);
  });

  it("hides everything when the installation is suspended or removed (AC-22), and shows it again after", async () => {
    const gh = world.alpha.installation.githubInstallationId;
    await setInstallationStatus(h.t.db, gh, "suspended");
    try {
      expect(await names(alice)).toEqual([]);
      expect((await h.request(alice, "GET", `/api/repos/${world.alpha.repo.id}`)).statusCode).toBe(
        404,
      );
      expect(
        (
          await h.request(
            alice,
            "GET",
            `/api/installations/${world.alpha.installation.id}/settings`,
          )
        ).statusCode,
      ).toBe(404);
      expect((await h.request(alice, "GET", "/api/me")).json().installations).toEqual([]);
    } finally {
      await setInstallationStatus(h.t.db, gh, "active");
    }
    expect(await names(alice)).toHaveLength(2);
  });
});
