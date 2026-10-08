// HTTP foundations (design §8, §9): error envelope, request ids, security headers, CORS and rate limits.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
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

beforeAll(async () => {
  h = await createHarness();
  world = await createWorld(h);
  alice = await h.signIn(world.alice);
}, 60_000);
afterAll(async () => {
  await h.close();
});

describe("error envelope and request ids", () => {
  it("every error is { error: { code, message, request_id } } with the id also in a header", async () => {
    for (const [res, status, code] of [
      [await h.request(undefined, "GET", "/api/me"), 401, "unauthorized"],
      [await h.request(alice, "GET", "/api/nothing-here"), 404, "not_found"],
      [await h.request(alice, "GET", "/api/repos/nope"), 404, "not_found"],
      [
        await h.request(alice, "PATCH", `/api/repos/${world.alpha.repo.id}/settings`, { body: {} }),
        400,
        "validation_error",
      ],
    ] as const) {
      expect(res.statusCode).toBe(status);
      const { error } = res.json();
      expect(error.code).toBe(code);
      expect(typeof error.message).toBe("string");
      expect(error.request_id).toBe(res.headers["x-request-id"]);
    }
  });

  it("generates an id per request and accepts a harmless one from the caller", async () => {
    const a = await h.request(undefined, "GET", "/api/me");
    const b = await h.request(undefined, "GET", "/api/me");
    expect(a.headers["x-request-id"]).not.toBe(b.headers["x-request-id"]);

    const mine = await h.request(undefined, "GET", "/api/me", {
      headers: { "x-request-id": "trace-abc.123" },
    });
    expect(mine.headers["x-request-id"]).toBe("trace-abc.123");

    const hostile = await h.request(undefined, "GET", "/api/me", {
      headers: { "x-request-id": "bad id with spaces <script>" },
    });
    expect(hostile.headers["x-request-id"]).not.toContain("script");
  });

  it("never echoes a malformed body or a framework message", async () => {
    const res = await h.request(alice, "PATCH", `/api/repos/${world.alpha.repo.id}/settings`, {
      rawBody: '{"config": {"instructions": "classified-text',
    });
    expect(res.statusCode).toBe(400);
    expect(res.body).not.toContain("classified-text");
    expect(res.json().error.message).toBe("The request body is not valid JSON");
  });

  it("rejects bodies over the limit and unsupported content types", async () => {
    const big = await h.request(alice, "PATCH", `/api/repos/${world.alpha.repo.id}/settings`, {
      body: { config: { instructions: "x".repeat(300 * 1024) } },
    });
    expect(big.statusCode).toBe(413);
    expect(big.json().error.code).toBe("payload_too_large");

    const text = await h.app.inject({
      method: "PATCH",
      url: `/api/repos/${world.alpha.repo.id}/settings`,
      headers: {
        cookie: alice.cookie,
        "x-csrf-token": alice.csrf,
        "content-type": "application/xml",
      },
      payload: "<hello/>",
    });
    expect(text.statusCode).toBe(415);
  });

  it("validation details name fields, not values", async () => {
    const res = await h.request(alice, "PATCH", `/api/repos/${world.alpha.repo.id}/settings`, {
      body: { config: { review: { mode: "super-secret-value" } } },
    });
    expect(res.statusCode).toBe(400);
    expect(res.body).not.toContain("super-secret-value");
    expect(res.json().error.details).toEqual([expect.stringContaining("review.mode")]);
  });
});

describe("security headers", () => {
  it("are set on successes, errors and unknown paths", async () => {
    for (const res of [
      await h.request(alice, "GET", "/api/me"),
      await h.request(undefined, "GET", "/api/me"),
      await h.request(undefined, "GET", "/api/does-not-exist"),
    ]) {
      expect(res.headers["x-content-type-options"]).toBe("nosniff");
      expect(res.headers["x-frame-options"]).toBe("DENY");
      expect(res.headers["referrer-policy"]).toBe("no-referrer");
      expect(res.headers["content-security-policy"]).toContain("default-src 'none'");
      expect(res.headers["content-security-policy"]).toContain("frame-ancestors 'none'");
      expect(res.headers["strict-transport-security"]).toContain("max-age=");
      expect(res.headers["cache-control"]).toBe("no-store");
      expect(res.headers["x-powered-by"]).toBeUndefined();
    }
  });

  it("keeps user data out of caches but leaves health probes alone", async () => {
    const health = await h.app.inject({ method: "GET", url: "/healthz" });
    expect(health.headers["cache-control"]).toBeUndefined();
    expect(health.headers["x-content-type-options"]).toBe("nosniff");
  });
});

describe("CORS (restricted to the web origin)", () => {
  it("answers a preflight from the dashboard with credentials and the CSRF header allowed", async () => {
    const res = await h.app.inject({
      method: "OPTIONS",
      url: "/api/repos/x/settings",
      headers: {
        origin: WEB_ORIGIN,
        "access-control-request-method": "PATCH",
        "access-control-request-headers": "content-type,x-csrf-token",
      },
    });
    expect(res.statusCode).toBe(204);
    expect(res.headers["access-control-allow-origin"]).toBe(WEB_ORIGIN);
    expect(res.headers["access-control-allow-credentials"]).toBe("true");
    expect(String(res.headers["access-control-allow-headers"]).toLowerCase()).toContain(
      "x-csrf-token",
    );
  });

  it("sends CORS headers on real responses to the dashboard origin only", async () => {
    const ok = await h.request(alice, "GET", "/api/me", { headers: { origin: WEB_ORIGIN } });
    expect(ok.headers["access-control-allow-origin"]).toBe(WEB_ORIGIN);
    expect(ok.headers["access-control-allow-credentials"]).toBe("true");

    for (const origin of ["https://evil.example", "http://localhost:5174", "null"]) {
      const res = await h.request(alice, "GET", "/api/me", { headers: { origin } });
      expect(res.headers["access-control-allow-origin"], origin).toBeUndefined();
    }
  });

  it("never answers with a wildcard", async () => {
    const res = await h.request(alice, "GET", "/api/me", { headers: { origin: WEB_ORIGIN } });
    expect(res.headers["access-control-allow-origin"]).not.toBe("*");
  });
});

describe("rate limits", () => {
  it("limits per IP, with Retry-After, and recovers when the window passes", async () => {
    const limited = await createHarness({ config: { rateLimitPerIpPerMinute: 5 } });
    try {
      const statuses: number[] = [];
      let last;
      for (let i = 0; i < 8; i++) {
        last = await limited.request(undefined, "GET", "/api/me");
        statuses.push(last.statusCode);
      }
      expect(statuses).toEqual([401, 401, 401, 401, 401, 429, 429, 429]);
      expect(last!.json().error.code).toBe("rate_limited");
      expect(Number(last!.headers["retry-after"])).toBeGreaterThan(0);

      limited.clock.advance(61_000);
      expect((await limited.request(undefined, "GET", "/api/me")).statusCode).toBe(401);
    } finally {
      await limited.close();
    }
  });

  it("limits per signed-in user, independently of other users", async () => {
    const limited = await createHarness({ config: { rateLimitPerUserPerMinute: 4 } });
    try {
      const w = await createWorld(limited);
      const a = await limited.signIn(w.alice);
      const v = await limited.signIn(w.victor);
      limited.clock.advance(61_000);
      const aliceStatuses: number[] = [];
      for (let i = 0; i < 6; i++)
        aliceStatuses.push((await limited.request(a, "GET", "/api/repos")).statusCode);
      expect(aliceStatuses).toEqual([200, 200, 200, 200, 429, 429]);
      expect((await limited.request(v, "GET", "/api/repos")).statusCode).toBe(200);
    } finally {
      await limited.close();
    }
  });

  it("does not limit the health probes", async () => {
    const limited = await createHarness({ config: { rateLimitPerIpPerMinute: 1 } });
    try {
      for (let i = 0; i < 5; i++) {
        expect((await limited.app.inject({ method: "GET", url: "/healthz" })).statusCode).toBe(200);
      }
    } finally {
      await limited.close();
    }
  });

  it("logs requests by route pattern and status without query strings or identifiers of secrets", async () => {
    h.logLines.length = 0;
    await h.request(alice, "GET", `/api/repos/${world.alpha.repo.id}?code=oauth-code-123`);
    const line = h.logLines.find((l) => l.includes("Request"))!;
    expect(line).toContain("route=/api/repos/:id");
    expect(line).toContain("status=200");
    expect(line).not.toContain("oauth-code-123");
    expect(line).not.toContain(world.alpha.repo.id);
  });
});
