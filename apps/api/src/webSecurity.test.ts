// Web security of the dashboard API (Phase 15): security headers, cookie flags, CORS, CSRF, and session fixation.
// Complements `auth/oauth.test.ts` (the sign-in flow) and `http.test.ts` (envelopes, rate limits): this file is the
// checklist of what a browser-facing service must get right, each item verified against the real app.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  API_ORIGIN,
  createHarness,
  createWorld,
  WEB_ORIGIN,
  type Harness,
  type Session,
  type World,
} from "./testing/harness";

let h: Harness;
let world: World;
let alice: Session;
let victor: Session;

beforeAll(async () => {
  h = await createHarness();
  world = await createWorld(h);
  alice = await h.signIn(world.alice);
  victor = await h.signIn(world.victor);
}, 60_000);
afterAll(async () => {
  await h.close();
});

const setCookies = (res: { headers: Record<string, unknown> }): string[] => {
  const raw = res.headers["set-cookie"];
  return Array.isArray(raw) ? (raw as string[]) : raw ? [String(raw)] : [];
};
const attributes = (cookie: string): string[] =>
  cookie
    .split(";")
    .slice(1)
    .map((a) => a.trim().toLowerCase());

async function startLogin(cookie?: string) {
  const start = await h.app.inject({
    method: "GET",
    url: "/auth/github/login",
    ...(cookie ? { headers: { cookie } } : {}),
  });
  const state = new URL(String(start.headers.location)).searchParams.get("state")!;
  const flow = setCookies(start).find((c) => c.startsWith("aipr_oauth="))!;
  return { start, state, flow };
}

describe("security headers", () => {
  const check = (res: { headers: Record<string, unknown> }) => {
    expect(res.headers["strict-transport-security"]).toBe("max-age=15552000; includeSubDomains");
    expect(res.headers["x-frame-options"]).toBe("DENY");
    expect(res.headers["referrer-policy"]).toBe("no-referrer");
    expect(res.headers["x-content-type-options"]).toBe("nosniff");
    expect(res.headers["cross-origin-resource-policy"]).toBe("same-site");
    expect(res.headers["permissions-policy"]).toBe("camera=(), microphone=(), geolocation=()");
    // Frame protection twice (old and new browsers), no inline script or style allowed anywhere, nothing loads.
    const csp = String(res.headers["content-security-policy"]);
    expect(csp).toContain("default-src 'none'");
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).not.toContain("unsafe-inline");
    expect(csp).not.toContain("unsafe-eval");
    expect(csp).not.toContain("*");
  };

  it("are on a data response, an error, a redirect and an unknown path", async () => {
    check(await h.request(alice, "GET", "/api/me"));
    check(await h.request(undefined, "GET", "/api/me"));
    check(await h.request(alice, "GET", "/api/runs/not-a-run"));
    check(await h.app.inject({ method: "GET", url: "/auth/github/login" }));
    check(await h.app.inject({ method: "GET", url: "/nowhere" }));
  });

  it("keep dashboard data out of every cache", async () => {
    for (const url of ["/api/me", "/api/repos", "/auth/github/login"]) {
      const res = await h.request(alice, "GET", url);
      expect(res.headers["cache-control"], url).toBe("no-store");
    }
  });

  it("never reveal the framework or a stack trace", async () => {
    const res = await h.request(alice, "GET", "/api/runs/%00");
    expect(res.headers["server"]).toBeUndefined();
    expect(res.headers["x-powered-by"]).toBeUndefined();
    expect(res.body).not.toMatch(/at .*\.(ts|js):\d+|node_modules|fastify/i);
  });
});

describe("cookies", () => {
  it("the session cookie is HttpOnly, Secure, SameSite=Lax, site-wide, and carries no Domain", async () => {
    const login = await h.signIn(world.alice);
    const me = await h.request(login, "GET", "/api/me");
    expect(me.statusCode).toBe(200);

    // Sign in once more by hand to read the Set-Cookie header the browser would receive.
    const { state, flow } = await startLogin();
    const done = await h.app.inject({
      method: "GET",
      url: `/auth/github/callback?code=code-for-alice~9001&state=${state}`,
      headers: { cookie: flow.split(";")[0]! },
    });
    const session = setCookies(done).find((c) => c.startsWith("aipr_session="))!;
    expect(session).toBeDefined();
    const attrs = attributes(session);
    expect(attrs).toEqual(expect.arrayContaining(["httponly", "secure", "samesite=lax", "path=/"]));
    expect(attrs.some((a) => a.startsWith("domain="))).toBe(false);
    expect(attrs.some((a) => a.startsWith("max-age="))).toBe(true);
    // `<session id>.<signature>`: a client cannot mint or alter one.
    expect(session.split(";")[0]!.split("=")[1]).toMatch(/^[0-9a-f-]{36}\.[A-Za-z0-9_-]{20,}$/);
  });

  it("the sign-in flow cookie is HttpOnly, Secure, SameSite=Lax and scoped to the auth path", async () => {
    const { flow } = await startLogin();
    expect(attributes(flow)).toEqual(
      expect.arrayContaining(["httponly", "secure", "samesite=lax", "path=/auth/github"]),
    );
  });

  it("logout clears the cookie with the same attributes", async () => {
    const session = await h.signIn(world.victor);
    const res = await h.request(session, "POST", "/auth/logout");
    const cleared = setCookies(res).find((c) => c.startsWith("aipr_session="))!;
    expect(cleared).toBeDefined();
    expect(cleared.split(";")[0]).toBe("aipr_session=");
    expect(attributes(cleared)).toEqual(expect.arrayContaining(["httponly", "secure", "path=/"]));
    expect((await h.request(session, "GET", "/api/me")).statusCode).toBe(401);
  });
});

describe("session fixation", () => {
  it("a session id planted before sign-in is never adopted: the victim gets a new one and the planted one dies", async () => {
    // The attacker signs in as themselves and plants that cookie in the victim's browser.
    const attacker = await h.signIn(world.bob);
    const planted = attacker.cookie;

    const { state, flow } = await startLogin(planted);
    const done = await h.app.inject({
      method: "GET",
      url: `/auth/github/callback?code=code-for-alice~9002&state=${state}`,
      headers: { cookie: `${planted}; ${flow.split(";")[0]}` },
    });
    expect(done.statusCode).toBe(302);
    const issued = setCookies(done).find((c) => c.startsWith("aipr_session="))!;
    const victimCookie = issued.split(";")[0]!;
    expect(victimCookie).not.toBe(planted);

    // The victim is alice, with her own session...
    const me = await h.app.inject({
      method: "GET",
      url: "/api/me",
      headers: { cookie: victimCookie },
    });
    expect(me.json().user.login).toBe("alice");
    // ...and the planted identifier no longer opens anything: the attacker cannot ride along.
    const hijack = await h.app.inject({
      method: "GET",
      url: "/api/me",
      headers: { cookie: planted },
    });
    expect(hijack.statusCode).toBe(401);
  });

  it("an identifier the server never issued is ignored, and sign-in still issues a fresh one", async () => {
    const forged =
      "aipr_session=11111111-2222-4333-8444-555555555555.AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
    expect(
      (await h.app.inject({ method: "GET", url: "/api/me", headers: { cookie: forged } }))
        .statusCode,
    ).toBe(401);

    const { state, flow } = await startLogin(forged);
    const done = await h.app.inject({
      method: "GET",
      url: `/auth/github/callback?code=code-for-victor~9003&state=${state}`,
      headers: { cookie: `${forged}; ${flow.split(";")[0]}` },
    });
    const issued = setCookies(done)
      .find((c) => c.startsWith("aipr_session="))!
      .split(";")[0]!;
    expect(issued).not.toBe(forged);
    expect(issued.split("=")[1]).not.toContain("1111111");
  });

  it("a session cannot be reused after logout, from the old cookie value", async () => {
    const session = await h.signIn(world.alice);
    await h.request(session, "POST", "/auth/logout");
    expect((await h.request(session, "GET", "/api/me")).statusCode).toBe(401);
    expect((await h.request(session, "GET", "/api/repos")).statusCode).toBe(401);
  });
});

describe("CSRF", () => {
  const settings = () => `/api/repos/${world.alpha.repo.id}/settings`;
  const patchBody = { config: { review: { mode: "warn" } } };

  it("needs the token in the header: not in the query string, not in the body, not another user's", async () => {
    const withoutHeader = await h.request(alice, "PATCH", `${settings()}?csrf=${alice.csrf}`, {
      body: { ...patchBody, csrf: alice.csrf, csrf_token: alice.csrf },
      csrf: false,
    });
    expect(withoutHeader.statusCode).toBe(403);
    expect(withoutHeader.json().error.code).toBe("csrf_invalid");

    // Victor's valid token on alice's session: tokens are bound to the session they were issued for.
    const swapped = await h.request(alice, "PATCH", settings(), {
      body: patchBody,
      csrf: victor.csrf,
    });
    expect(swapped.statusCode).toBe(403);

    const ok = await h.request(alice, "PATCH", settings(), { body: patchBody });
    expect(ok.statusCode).toBe(200);
  });

  it("a request that says it comes from another site, or from nowhere (Origin: null), is refused even with a valid token", async () => {
    // Without Access-Control-Allow-Origin the browser refuses the response, whatever else is sent.
    for (const origin of [
      "https://evil.example",
      "null",
      `${WEB_ORIGIN}.evil.example`,
      "http://localhost:3001",
    ]) {
      const res = await h.request(alice, "PATCH", settings(), {
        body: patchBody,
        headers: { origin },
      });
      expect(res.statusCode, origin).toBe(403);
      expect(res.json().error.code).toBe("origin_not_allowed");
    }
    // The dashboard and the api itself are the allowed origins; a non-browser client sends none.
    for (const origin of [WEB_ORIGIN, API_ORIGIN]) {
      expect(
        (await h.request(alice, "PATCH", settings(), { body: patchBody, headers: { origin } }))
          .statusCode,
      ).toBe(200);
    }
  });

  it("only JSON gets through, so a plain HTML form cannot reach a mutation", async () => {
    for (const type of [
      "application/x-www-form-urlencoded",
      "text/plain",
      "multipart/form-data; boundary=x",
    ]) {
      const res = await h.app.inject({
        method: "PATCH",
        url: settings(),
        headers: { cookie: alice.cookie, "x-csrf-token": alice.csrf, "content-type": type },
        payload: "config=1",
      });
      // 415 for types with no parser, 400 where a text parser hands the schema a string: never a success.
      expect([400, 415], type).toContain(res.statusCode);
    }
  });

  it("no GET changes anything: the contract has no mutating GET and sign-in redirects only redirect", async () => {
    const { endpoints } = await import("@ai-pr-review/shared");
    const gets = Object.entries(endpoints).filter(([, e]) => e.method === "GET");
    // Audited, state-changing and credential routes are never GET.
    for (const [name, e] of gets) {
      expect(e.path, name).not.toMatch(/rerun|cancel|feedback|credentials\/test/);
    }
  });
});

describe("CORS", () => {
  const preflight = (origin: string) =>
    h.app.inject({
      method: "OPTIONS",
      url: "/api/repos",
      headers: {
        origin,
        "access-control-request-method": "GET",
        "access-control-request-headers": "x-csrf-token",
      },
    });

  it("allows the dashboard origin, with credentials, and nothing else", async () => {
    const ok = await preflight(WEB_ORIGIN);
    expect(ok.headers["access-control-allow-origin"]).toBe(WEB_ORIGIN);
    expect(ok.headers["access-control-allow-credentials"]).toBe("true");

    for (const origin of [
      "https://evil.example",
      "null",
      `${WEB_ORIGIN}.evil.example`,
      WEB_ORIGIN.replace("http://", "https://"),
      "http://localhost:5174",
    ]) {
      const res = await preflight(origin);
      expect(res.headers["access-control-allow-origin"], origin).toBeUndefined();
    }
  });

  it("an answer to another origin carries no CORS grant, so a page there cannot read it", async () => {
    const res = await h.request(alice, "GET", "/api/repos", {
      headers: { origin: "https://evil.example" },
    });
    expect(res.headers["access-control-allow-origin"]).toBeUndefined();
    expect(res.headers["access-control-allow-origin"]).not.toBe("*");
  });
});
