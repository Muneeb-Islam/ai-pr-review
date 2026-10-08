// Route inventory (Phase 15, AC-17): every route the running app registers has an entry. A route of the dashboard
// API must be in the contract, which `authorization.test.ts` walks as anonymous, another tenant, a viewer and an
// admin. A route outside the contract (health, webhooks, metrics) must be listed here with the way it keeps
// anonymous callers out. A route that is in neither place fails the build, so a new endpoint cannot ship
// without someone deciding who may call it.
import { endpoints } from "@ai-pr-review/shared";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createHarness, type Harness } from "./testing/harness";

const METRICS_TOKEN = "metrics-token-0123456789";

const registered: string[] = [];
let h: Harness;

beforeAll(async () => {
  h = await createHarness({
    app: {
      onRoute: (route) => {
        for (const method of [route.method].flat()) registered.push(`${method} ${route.url}`);
      },
      metrics: { token: METRICS_TOKEN, collect: async () => "aipr_up 1\n" },
    },
    webhooks: {},
  });
}, 60_000);

afterAll(async () => {
  await h.close();
});

/** Routes outside the contract and how an anonymous request to each is answered. */
const OUTSIDE_THE_CONTRACT: Record<
  string,
  { why: string; anonymous: { method: "GET" | "POST"; url: string; status: number } }
> = {
  "GET /healthz": {
    why: "liveness probe: says only that the process is up",
    anonymous: { method: "GET", url: "/healthz", status: 200 },
  },
  "GET /readyz": {
    why: "readiness probe: ok/fail per dependency, no detail",
    anonymous: { method: "GET", url: "/readyz", status: 200 },
  },
  "POST /webhooks/github": {
    why: "GitHub webhooks: authenticated by the HMAC signature of the raw body",
    anonymous: { method: "POST", url: "/webhooks/github", status: 401 },
  },
  "GET /metrics": {
    why: "operator metrics: authenticated by a bearer token, absent without one",
    anonymous: { method: "GET", url: "/metrics", status: 401 },
  },
};

const isFramework = (route: string) => route.startsWith("HEAD ") || route.startsWith("OPTIONS ");

describe("route inventory", () => {
  it("every registered route is in the contract or listed as outside it", () => {
    const contract = new Set(Object.values(endpoints).map((e) => `${e.method} ${e.path}`));
    const known = new Set([...contract, ...Object.keys(OUTSIDE_THE_CONTRACT)]);
    const unknown = registered.filter((r) => !isFramework(r) && !known.has(r));
    expect(
      unknown,
      "A route has no authorisation entry. Put it in packages/shared/src/api/contract.ts (it is then covered by " +
        "authorization.test.ts) or list it in OUTSIDE_THE_CONTRACT with how it keeps anonymous callers out.",
    ).toEqual([]);
  });

  it("every contract endpoint and every listed route is really registered (no stale entries)", () => {
    const registeredSet = new Set(registered);
    for (const e of Object.values(endpoints)) {
      expect(registeredSet.has(`${e.method} ${e.path}`), `${e.method} ${e.path}`).toBe(true);
    }
    for (const route of Object.keys(OUTSIDE_THE_CONTRACT)) {
      expect(registeredSet.has(route), route).toBe(true);
    }
  });

  it("the authorisation matrix covers every contract endpoint with a session (the only public ones are the sign-in redirects)", () => {
    const publicOnes = Object.entries(endpoints)
      .filter(([, e]) => e.auth === "none")
      .map(([name]) => name)
      .sort();
    expect(publicOnes).toEqual(["login", "loginCallback"]);
  });

  it.each(Object.entries(OUTSIDE_THE_CONTRACT))(
    "%s answers an anonymous caller as documented",
    async (_route, { anonymous }) => {
      const res = await h.app.inject({
        method: anonymous.method,
        url: anonymous.url,
        ...(anonymous.method === "POST"
          ? { headers: { "content-type": "application/json" }, payload: "{}" }
          : {}),
      });
      expect(res.statusCode).toBe(anonymous.status);
      // None of them hands out tenant data to someone who is not signed in.
      expect(res.body).not.toMatch(/full_name|repo|finding|login/i);
    },
  );

  it("unknown paths are a plain 404 that says nothing about the routes behind them", async () => {
    for (const url of ["/api/secret", "/admin", "/api/runs/../../etc/passwd", "/.env"]) {
      const res = await h.app.inject({ method: "GET", url });
      expect(res.statusCode, url).toBe(404);
    }
  });
});
