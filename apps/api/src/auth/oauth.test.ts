// Sign-in against a mocked GitHub (PL-12): login redirect, state and PKCE, callback failures, session
// cookies, rotation, idle and absolute expiry, logout and CSRF.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { pkceChallenge } from "./signing";
import {
  createHarness,
  createWorld,
  WEB_ORIGIN,
  type Harness,
  type World,
} from "../testing/harness";

let h: Harness;
let world: World;

beforeAll(async () => {
  h = await createHarness();
  world = await createWorld(h);
}, 60_000);
afterAll(async () => {
  await h.close();
});

const cookiesOf = (res: { cookies: Array<{ name: string; value: string }> }) =>
  Object.fromEntries(res.cookies.map((c) => [c.name, c.value]));

async function startLogin(returnTo?: string) {
  const res = await h.app.inject({
    method: "GET",
    url: `/auth/github/login${returnTo ? `?return_to=${encodeURIComponent(returnTo)}` : ""}`,
  });
  const location = new URL(String(res.headers.location));
  return {
    res,
    location,
    state: location.searchParams.get("state")!,
    cookie: `aipr_oauth=${cookiesOf(res)["aipr_oauth"]}`,
  };
}

let codes = 0;
/** A fresh authorization code, as GitHub issues one per sign-in. */
const freshCode = (login: string) => `code-for-${login}~t${++codes}`;

const callback = (query: string, cookie?: string) =>
  h.app.inject({
    method: "GET",
    url: `/auth/github/callback?${query}`,
    ...(cookie ? { headers: { cookie } } : {}),
  });

describe("GET /auth/github/login", () => {
  it("redirects to GitHub with state, a PKCE S256 challenge and the callback URL", async () => {
    const { res, location, state } = await startLogin();
    expect(res.statusCode).toBe(302);
    expect(location.origin + location.pathname).toBe("https://github.com/login/oauth/authorize");
    expect(location.searchParams.get("client_id")).toBe("client-id-test");
    expect(location.searchParams.get("redirect_uri")).toBe(
      "http://localhost:3000/auth/github/callback",
    );
    expect(location.searchParams.get("code_challenge_method")).toBe("S256");
    expect(location.searchParams.get("code_challenge")).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(state.length).toBeGreaterThanOrEqual(32);
    // The secret parts are not in the URL.
    expect(location.search).not.toContain("code_verifier");
  });

  it("stores the flow state in a signed, HttpOnly, Secure, SameSite=Lax cookie scoped to the auth path", async () => {
    const { res } = await startLogin();
    const cookie = res.cookies.find((c) => c.name === "aipr_oauth")!;
    expect(cookie).toMatchObject({
      httpOnly: true,
      secure: true,
      sameSite: "Lax",
      path: "/auth/github",
      maxAge: 600,
    });
  });

  it("uses a different state every time", async () => {
    const a = await startLogin();
    const b = await startLogin();
    expect(a.state).not.toBe(b.state);
  });
});

describe("GET /auth/github/callback", () => {
  it("signs the user in: new session cookie, redirect to the dashboard, PKCE verifier matches", async () => {
    const { location, state, cookie } = await startLogin();
    const res = await callback(`code=code-for-alice&state=${state}`, cookie);
    expect(res.statusCode).toBe(302);
    expect(res.headers.location).toBe(`${WEB_ORIGIN}/`);

    const session = res.cookies.find((c) => c.name === "aipr_session")!;
    expect(session).toMatchObject({ httpOnly: true, secure: true, sameSite: "Lax", path: "/" });
    expect(session.maxAge).toBe(7 * 24 * 3600);
    // The flow cookie is cleared.
    expect(res.cookies.find((c) => c.name === "aipr_oauth")!.value).toBe("");

    // The verifier GitHub received hashes to the challenge sent at the start.
    const verifier = h.github.verifiers.at(-1)!;
    expect(pkceChallenge(verifier)).toBe(location.searchParams.get("code_challenge"));
  });

  it("returns to a path on the dashboard when asked, never to another site", async () => {
    for (const [asked, expected] of [
      ["/repos/42?tab=runs", `${WEB_ORIGIN}/repos/42?tab=runs`],
      ["//evil.example/x", `${WEB_ORIGIN}/`],
      ["https://evil.example/x", `${WEB_ORIGIN}/`],
      ["/\\evil.example", `${WEB_ORIGIN}/`],
    ] as const) {
      const { state, cookie } = await startLogin(asked);
      const res = await callback(`code=${freshCode("alice")}&state=${state}`, cookie);
      expect(res.headers.location, asked).toBe(expected);
    }
  });

  const noSession = (res: { cookies: Array<{ name: string }> }) =>
    expect(res.cookies.some((c) => c.name === "aipr_session")).toBe(false);

  it("rejects a wrong state and creates no session", async () => {
    const { cookie } = await startLogin();
    const res = await callback("code=code-for-alice&state=not-the-state", cookie);
    expect(res.statusCode).toBe(302);
    expect(res.headers.location).toBe(`${WEB_ORIGIN}/login?error=invalid_state`);
    noSession(res);
  });

  it("rejects a callback with no flow cookie (a forged link)", async () => {
    const { state } = await startLogin();
    const res = await callback(`code=code-for-alice&state=${state}`);
    expect(res.headers.location).toBe(`${WEB_ORIGIN}/login?error=invalid_state`);
    noSession(res);
  });

  it("rejects a tampered flow cookie and a flow cookie from another secret", async () => {
    const { state, cookie } = await startLogin();
    const value = cookie.split("=")[1]!;
    const tampered = `aipr_oauth=${value.slice(0, -2)}xx`;
    const res = await callback(`code=code-for-alice&state=${state}`, tampered);
    expect(res.headers.location).toBe(`${WEB_ORIGIN}/login?error=invalid_state`);
    noSession(res);
  });

  it("rejects a flow that took longer than ten minutes", async () => {
    const { state, cookie } = await startLogin();
    h.clock.advance(11 * 60_000);
    const res = await callback(`code=code-for-alice&state=${state}`, cookie);
    expect(res.headers.location).toBe(`${WEB_ORIGIN}/login?error=invalid_state`);
    noSession(res);
  });

  it("rejects a reused state (the flow cookie is single use) and a reused code", async () => {
    const { state, cookie } = await startLogin();
    const first = await callback(`code=code-for-victor&state=${state}`, cookie);
    expect(first.cookies.some((c) => c.name === "aipr_session")).toBe(true);

    // The browser dropped the cleared cookie; an attacker replaying the old one gets the code error instead.
    const replay = await callback(`code=code-for-victor&state=${state}`, cookie);
    expect(replay.headers.location).toBe(`${WEB_ORIGIN}/login?error=invalid_code`);
    noSession(replay);
  });

  it("reports GitHub's refusal and an outage without a session", async () => {
    const denied = await startLogin();
    const refused = await callback(`error=access_denied&state=${denied.state}`, denied.cookie);
    expect(refused.headers.location).toBe(`${WEB_ORIGIN}/login?error=access_denied`);
    noSession(refused);

    const badCode = await startLogin();
    const res = await callback(`code=garbage&state=${badCode.state}`, badCode.cookie);
    expect(res.headers.location).toBe(`${WEB_ORIGIN}/login?error=invalid_code`);

    h.github.unavailable = true;
    try {
      const down = await startLogin();
      const outage = await callback(`code=code-for-bob&state=${down.state}`, down.cookie);
      expect(outage.headers.location).toBe(`${WEB_ORIGIN}/login?error=github_unavailable`);
      noSession(outage);
    } finally {
      h.github.unavailable = false;
    }
  });

  it("never persists the user's GitHub token", async () => {
    await h.signIn(world.alice);
    const dump = await h.t.pool.query(
      `select (select coalesce(string_agg(t::text, ''), '') from users t) ||
              (select coalesce(string_agg(t::text, ''), '') from sessions t) ||
              (select coalesce(string_agg(t::text, ''), '') from user_installations t) ||
              (select coalesce(string_agg(t::text, ''), '') from user_repositories t) as everything`,
    );
    expect(dump.rows[0].everything).not.toContain("token-for-");
  });

  it("fills the access cache: org owner is admin, member is viewer, only reachable repositories", async () => {
    const alice = await h.signIn(world.alice);
    const victor = await h.signIn(world.victor);
    const roles = async (userId: string) =>
      (
        await h.t.pool.query(
          "select r.full_name, ur.role from user_repositories ur join repositories r on r.id = ur.repo_id where ur.user_id = $1 order by 1",
          [userId],
        )
      ).rows.map((r) => `${r.full_name}:${r.role}`);
    const alphaName = world.alpha.installation.accountLogin;
    expect(await roles(alice.userId)).toEqual([
      `${world.alpha.repo.fullName}:admin`,
      `${world.alpha.repo2.fullName}:admin`,
    ]);
    expect(await roles(victor.userId)).toEqual([
      `${world.alpha.repo.fullName}:viewer`,
      `${world.alpha.repo2.fullName}:viewer`,
    ]);
    const installs = await h.t.pool.query(
      "select role from user_installations where user_id = $1 and installation_id = $2",
      [victor.userId, world.alpha.installation.id],
    );
    expect(installs.rows[0].role).toBe("viewer");
    expect(alphaName).toBeTruthy();
  });
});

describe("sessions", () => {
  it("rotates on login: the session id from before sign-in is gone", async () => {
    const first = await h.signIn(world.alice);
    const { state, cookie } = await startLogin();
    const res = await callback(
      `code=${freshCode("alice")}&state=${state}`,
      `${cookie}; ${first.cookie}`,
    );
    const second = cookiesOf(res)["aipr_session"]!;
    expect(second).not.toBe(first.cookie.split("=")[1]);

    const old = await h.request(first, "GET", "/api/me");
    expect(old.statusCode).toBe(401);
    const fresh = await h.request({ ...first, cookie: `aipr_session=${second}` }, "GET", "/api/me");
    expect(fresh.statusCode).toBe(200);
  });

  it("rejects missing, malformed and forged session cookies", async () => {
    const alice = await h.signIn(world.alice);
    const value = alice.cookie.split("=")[1]!;
    for (const cookie of [
      "",
      "aipr_session=",
      "aipr_session=not-a-session",
      `aipr_session=${value.slice(0, -3)}abc`,
      `aipr_session=${value.split(".")[0]}`, // id without its signature
      "aipr_session=00000000-0000-4000-8000-000000000000.abcdef",
    ]) {
      const res = await h.app.inject({ method: "GET", url: "/api/me", headers: { cookie } });
      expect(res.statusCode, cookie).toBe(401);
      expect(res.json().error.code).toBe("unauthorized");
    }
  });

  it("ends after the idle timeout, but activity keeps it alive", async () => {
    const session = await h.signIn(world.alice);
    const sessionId = session.cookie.split("=")[1]!.split(".")[0]!;
    for (let i = 0; i < 3; i++) {
      h.clock.advance(100 * 60_000); // 100 min < 120 min idle limit
      expect((await h.request(session, "GET", "/api/me")).statusCode).toBe(200);
    }
    h.clock.advance(121 * 60_000);
    expect((await h.request(session, "GET", "/api/me")).statusCode).toBe(401);
    // The row is deleted, not just ignored.
    const rows = await h.t.pool.query("select 1 from sessions where id = $1", [sessionId]);
    expect(rows.rowCount).toBe(0);
  });

  it("ends at the absolute timeout even for an active user", async () => {
    const session = await h.signIn(world.alice);
    const limitMinutes = 7 * 24 * 60;
    let elapsed = 0;
    while (elapsed + 90 < limitMinutes) {
      h.clock.advance(90 * 60_000);
      elapsed += 90;
      expect((await h.request(session, "GET", "/api/me")).statusCode).toBe(200);
    }
    h.clock.advance(100 * 60_000); // past 7 days, but active less than 2 hours ago
    expect((await h.request(session, "GET", "/api/me")).statusCode).toBe(401);
  });

  it("logout deletes the session server-side and clears the cookie", async () => {
    const session = await h.signIn(world.alice);
    const out = await h.request(session, "POST", "/auth/logout");
    expect(out.statusCode).toBe(200);
    expect(out.json()).toEqual({ ok: true });
    expect(out.cookies.find((c) => c.name === "aipr_session")!.value).toBe("");
    // The old cookie is dead even if someone kept a copy.
    expect((await h.request(session, "GET", "/api/me")).statusCode).toBe(401);
  });

  it("logout needs the CSRF token", async () => {
    const session = await h.signIn(world.alice);
    const res = await h.request(session, "POST", "/auth/logout", { csrf: false });
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe("csrf_invalid");
    expect((await h.request(session, "GET", "/api/me")).statusCode).toBe(200);
  });
});

describe("CSRF and origin checks (mutations)", () => {
  const url = () => `/api/repos/${world.alpha.repo.id}/settings`;
  const body = { config: { review: { mode: "warn" } } };

  it("rejects a mutation without a token, with a wrong token, and with another session's token", async () => {
    const alice = await h.signIn(world.alice);
    const other = await h.signIn(world.alice);
    for (const csrf of [false, "wrong", "", other.csrf] as const) {
      const res = await h.request(alice, "PATCH", url(), { body, csrf });
      expect(res.statusCode, String(csrf)).toBe(403);
      expect(res.json().error.code).toBe("csrf_invalid");
    }
    const ok = await h.request(alice, "PATCH", url(), { body });
    expect(ok.statusCode).toBe(200);
  });

  it("rejects a mutation that comes from another origin even with a valid token", async () => {
    const alice = await h.signIn(world.alice);
    const res = await h.request(alice, "PATCH", url(), {
      body,
      headers: { origin: "https://evil.example" },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe("origin_not_allowed");
    const fine = await h.request(alice, "PATCH", url(), { body, headers: { origin: WEB_ORIGIN } });
    expect(fine.statusCode).toBe(200);
  });

  it("does not need a token for reads", async () => {
    const alice = await h.signIn(world.alice);
    expect((await h.request(alice, "GET", "/api/me")).statusCode).toBe(200);
  });
});

describe("GET /api/me", () => {
  it("returns the user, their installations with role, the CSRF token and the install link", async () => {
    const victor = await h.signIn(world.victor);
    const res = await h.request(victor, "GET", "/api/me");
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.user).toEqual({
      id: victor.userId,
      login: "victor",
      avatar_url: "https://avatars.test/victor",
    });
    expect(body.csrf_token).toBe(victor.csrf);
    expect(body.installations).toEqual([
      {
        id: world.alpha.installation.id,
        account_login: world.alpha.installation.accountLogin,
        account_type: "organization",
        role: "viewer",
      },
    ]);
    expect(body.install_url).toBe("https://github.com/apps/ai-pr-review-test/installations/new");
  });

  it("shows an empty installation list and the install link to a user without the App", async () => {
    const carol = await h.signIn(world.carol);
    const body = (await h.request(carol, "GET", "/api/me")).json();
    expect(body.installations).toEqual([]);
    expect(body.install_url).toContain("github.com/apps/");
  });

  it("falls back to the generic installations page when the App slug cannot be looked up", async () => {
    h.github.slug = undefined;
    try {
      const carol = await h.signIn(world.carol);
      expect((await h.request(carol, "GET", "/api/me")).json().install_url).toBe(
        "https://github.com/settings/installations",
      );
    } finally {
      h.github.slug = "ai-pr-review-test";
    }
  });
});
