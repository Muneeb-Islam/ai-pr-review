// Planted canaries, the api's half (AC-18): secrets that live in the database or the server's own configuration must not
// appear in any response or log line. The worker's half (provider requests, posted comments) is in
// `apps/worker/src/hardening.test.ts`. Every GET endpoint is walked as an administrator, the one role that may see the
// most, and the credential endpoints are exercised with a canary key.
import { endpoints, type EndpointDef, type EndpointName } from "@ai-pr-review/shared";
import { makeFullRun, makeRun } from "@ai-pr-review/db/testing";
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
let reviewed: Awaited<ReturnType<typeof makeFullRun>>;
let runId: string;

/** A provider key the user types into the dashboard. */
const KEY = ["sk-canary", "dashboard", "key", "Zy9X8w7V6u5T4s3R"].join("-");
/** Bytes planted in the ciphertext column: what an attacker who read the table would see. */
const CIPHERTEXT = "CANARY-CIPHERTEXT-BYTES-0123456789abcdef";
let sessionCsrfSecret = "";

beforeAll(async () => {
  h = await createHarness();
  world = await createWorld(h);
  alice = await h.signIn(world.alice);
  runId = (await makeRun(h.t.db, world.alpha, { repo: world.alpha.repo2 })).id;
  reviewed = await makeFullRun(h.t.db, world.alpha);

  // A key stored through the real endpoint (so it is really encrypted), and bytes planted next to it.
  const put = await h.request(alice, "PUT", `/api/repos/${world.alpha.repo.id}/credentials`, {
    body: { provider: "deepseek", api_key: KEY },
  });
  expect(put.statusCode).toBe(200);
  await h.t.pool.query(
    "insert into provider_credentials (installation_id, provider, ciphertext, key_version, last4) values ($1, 'openai', $2, 1, 'abcd')",
    [world.alpha.installation.id, Buffer.from(CIPHERTEXT)],
  );
  const { rows } = await h.t.pool.query("select csrf_secret from sessions where user_id = $1", [
    alice.userId,
  ]);
  sessionCsrfSecret = rows[0].csrf_secret;
}, 60_000);

afterAll(async () => {
  await h.close();
});

function urlFor(name: EndpointName): string {
  const def: EndpointDef = endpoints[name];
  const id =
    def.resource === "installation"
      ? world.alpha.installation.id
      : def.resource === "run"
        ? runId
        : def.resource === "finding"
          ? reviewed.finding.id
          : world.alpha.repo.id;
  let url = def.path.replace(":id", id).replace(":number", String(reviewed.run.prNumber));
  if (name === "exportCsv") url += "?kind=runs";
  return url;
}

/** Everything that must never show: the stored key, the planted ciphertext, the secrets of the session and the server. */
function secrets(): Record<string, string> {
  return {
    "the provider key": KEY,
    "the ciphertext": CIPHERTEXT,
    "the session's CSRF secret": sessionCsrfSecret,
    "the session secret": h.config.sessionSecret,
    "the GitHub client secret": h.config.githubClientSecret,
  };
}

function expectClean(label: string, text: string): void {
  for (const [what, value] of Object.entries(secrets())) {
    expect(value.length).toBeGreaterThan(8); // a canary that is too short proves nothing
    expect(text.includes(value), `${label} contains ${what}`).toBe(false);
  }
}

describe("GET endpoints, as an administrator", () => {
  const gets = (Object.keys(endpoints) as EndpointName[]).filter(
    (n) =>
      endpoints[n].method === "GET" &&
      endpoints[n].auth === "session" &&
      !("stream" in endpoints[n]),
  );

  it.each(gets)("%s returns none of the secrets, in the body or the headers", async (name) => {
    const res = await h.request(alice, "GET", urlFor(name));
    expect(res.statusCode, `${name}: ${res.body.slice(0, 200)}`).toBe(200);
    expectClean(`${name} body`, res.body);
    expectClean(`${name} headers`, JSON.stringify(res.headers));
  });

  it("the credential listing shows provider, last four characters and a time, and nothing that decrypts", async () => {
    const res = await h.request(alice, "GET", `/api/repos/${world.alpha.repo.id}/credentials`);
    const body = res.json();
    expect(JSON.stringify(body)).toContain(KEY.slice(-4));
    expect(JSON.stringify(Object.keys(body.items?.[0] ?? body[0] ?? {}).sort())).not.toMatch(
      /cipher|key_version|api_key|secret/,
    );
  });

  it("the CSRF token the api hands out is derived: it is not the stored secret", async () => {
    const me = (await h.request(alice, "GET", "/api/me")).json();
    expect(me.csrf_token).not.toBe(sessionCsrfSecret);
    expect(me.csrf_token).not.toContain(sessionCsrfSecret);
  });
});

describe("writes and errors", () => {
  it("replacing and deleting a key answers without the key and logs without it", async () => {
    const replaced = await h.request(
      alice,
      "PUT",
      `/api/repos/${world.alpha.repo.id}/credentials`,
      {
        body: { provider: "deepseek", api_key: KEY },
      },
    );
    expect(replaced.statusCode).toBe(200);
    expectClean("the PUT response", replaced.body);
    const removed = await h.request(
      alice,
      "DELETE",
      `/api/repos/${world.alpha.repo.id}/credentials?provider=deepseek`,
    );
    expectClean("the DELETE response", removed.body);
    expectClean("the log", h.logLines.join("\n"));
  });

  it("a rejected request never echoes the key it carried: bad provider, bad shape, bad JSON, wrong content type", async () => {
    const url = `/api/repos/${world.alpha.repo.id}/credentials`;
    const bad = [
      await h.request(alice, "PUT", url, { body: { provider: "not-a-provider", api_key: KEY } }),
      await h.request(alice, "PUT", url, {
        body: { provider: "deepseek", api_key: KEY, extra: KEY },
      }),
      await h.request(alice, "PUT", url, { rawBody: `{"provider":"deepseek","api_key":"${KEY}"` }),
      await h.app.inject({
        method: "PUT",
        url,
        headers: { cookie: alice.cookie, "x-csrf-token": alice.csrf, "content-type": "text/plain" },
        payload: KEY,
      }),
      await h.request(alice, "PUT", url, {
        body: { provider: "deepseek", api_key: `${KEY} with spaces and "quotes"` },
      }),
    ];
    for (const res of bad) {
      expect(res.statusCode).toBeGreaterThanOrEqual(400);
      expectClean(`error ${res.statusCode}`, res.body);
    }
    expectClean("the log", h.logLines.join("\n"));
  });

  it("a rejected key (from a user without admin rights, or for another tenant) is not echoed either", async () => {
    const victor = await h.signIn(world.victor);
    const bob = await h.signIn(world.bob);
    for (const session of [victor, bob]) {
      const res = await h.request(session, "PUT", `/api/repos/${world.alpha.repo.id}/credentials`, {
        body: { provider: "deepseek", api_key: KEY },
      });
      expect([403, 404]).toContain(res.statusCode);
      expectClean(`denied ${res.statusCode}`, res.body);
    }
    expectClean("the log", h.logLines.join("\n"));
  });

  it("the test-connection answer says whether the key was accepted, never what it was", async () => {
    h.probe.result = { ok: false, message: `The provider rejected the key ${KEY}` };
    const res = await h.request(
      alice,
      "POST",
      `/api/repos/${world.alpha.repo.id}/credentials/test`,
      {
        body: { provider: "deepseek", api_key: KEY },
      },
    );
    expect(res.statusCode).toBe(200);
    expectClean("the test response", res.body);
    expectClean("the log", h.logLines.join("\n"));
    h.probe.result = { ok: true, message: "The provider accepted the key." };
  });
});
