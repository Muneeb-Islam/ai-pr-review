// Provider credentials (PL-10, AC-18): write-only, encrypted at rest, never in responses, logs or errors.
import { credentialContext, decryptSecret, DecryptionError, Keyring } from "@ai-pr-review/core";
import { listAuditLog } from "@ai-pr-review/db";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
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

beforeAll(async () => {
  h = await createHarness();
  world = await createWorld(h);
  alice = await h.signIn(world.alice);
}, 60_000);
afterAll(async () => {
  await h.close();
});

const KEY = "sk-live-0123456789abcdefWXYZ";
const repoUrl = () => `/api/repos/${world.alpha.repo.id}/credentials`;
const installationUrl = () => `/api/installations/${world.alpha.installation.id}/credentials`;
const put = (url: string, api_key = KEY, provider = "deepseek") =>
  h.request(alice, "PUT", url, { body: { provider, api_key } });

beforeEach(async () => {
  await h.t.pool.query("delete from provider_credentials");
  await h.t.pool.query("delete from repo_settings");
  h.logLines.length = 0;
  h.probe.calls.length = 0;
  h.dns.addresses = ["104.18.2.55"];
  h.clock.advance(61_000); // a fresh rate-limit window for every test
});

const stored = async () =>
  (await h.t.pool.query("select * from provider_credentials order by created_at")).rows as Array<{
    id: string;
    repo_id: string | null;
    provider: string;
    ciphertext: Buffer;
    key_version: number;
    last4: string;
  }>;

describe("PUT /api/repos/:id/credentials", () => {
  it("returns the provider, scope, last four characters and a timestamp: nothing else", async () => {
    const res = await put(repoUrl());
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      credential: {
        id: expect.any(String),
        provider: "deepseek",
        scope: "repository",
        last4: "WXYZ",
        created_at: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/),
      },
    });
    expect(res.body).not.toContain(KEY);
    expect(res.body).not.toContain("ciphertext");
  });

  it("stores only ciphertext: not the key, not part of it, not decryptable without the right key and context", async () => {
    await put(repoUrl());
    const [row] = await stored();
    expect(row!.key_version).toBe(1);
    expect(row!.last4).toBe("WXYZ");
    for (const part of [KEY, KEY.slice(0, 12), KEY.slice(4, 20)]) {
      expect(row!.ciphertext.includes(Buffer.from(part)), part).toBe(false);
    }
    const context = credentialContext(
      { installationId: world.alpha.installation.id, repoId: world.alpha.repo.id },
      "deepseek",
    );
    expect(decryptSecret(row!.ciphertext, 1, h.keyring, context)).toBe(KEY);
    expect(() => decryptSecret(row!.ciphertext, 1, h.keyring, "credential:other")).toThrow(
      DecryptionError,
    );
    expect(() =>
      decryptSecret(
        row!.ciphertext,
        1,
        new Keyring({ version: 1, key: Buffer.alloc(32, 7) }),
        context,
      ),
    ).toThrow(DecryptionError);
  });

  it("gives different ciphertext for the same key stored twice or in two places", async () => {
    await put(repoUrl());
    const first = (await stored())[0]!.ciphertext;
    await put(repoUrl()); // replace
    const second = (await stored())[0]!.ciphertext;
    expect(second.equals(first)).toBe(false);

    await put(installationUrl());
    const rows = await stored();
    expect(rows).toHaveLength(2);
    expect(rows[0]!.ciphertext.equals(rows[1]!.ciphertext)).toBe(false);
  });

  it("replaces the key for the same provider and scope instead of adding another", async () => {
    await put(repoUrl(), "sk-first-0123456789aaaa");
    const res = await put(repoUrl(), "sk-second-0123456789bbbb");
    expect(res.json().credential.last4).toBe("bbbb");
    const rows = await stored();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.last4).toBe("bbbb");
  });

  it("keeps one key per provider, and repository and installation scopes apart", async () => {
    await put(repoUrl(), KEY, "deepseek");
    await put(repoUrl(), KEY, "openai");
    await put(installationUrl(), KEY, "deepseek");
    const repoList = (await h.request(alice, "GET", repoUrl())).json().items;
    expect(
      repoList.map((c: { provider: string; scope: string }) => `${c.scope}:${c.provider}`),
    ).toEqual(["repository:openai", "repository:deepseek"]);
    const installationList = (await h.request(alice, "GET", installationUrl())).json().items;
    expect(installationList.map((c: { scope: string }) => c.scope)).toEqual(["installation"]);
  });

  it.each([
    ["too short", { provider: "deepseek", api_key: "short" }],
    ["with a space", { provider: "deepseek", api_key: "sk-has a space-0123456789" }],
    ["with a newline", { provider: "deepseek", api_key: "sk-0123456789\nabcdef" }],
    ["too long", { provider: "deepseek", api_key: "k".repeat(513) }],
    ["for an unknown provider", { provider: "skynet", api_key: KEY }],
    ["with an extra field", { provider: "deepseek", api_key: KEY, scope: "installation" }],
    ["without a key", { provider: "deepseek" }],
  ])("rejects a request %s and stores nothing", async (_name, body) => {
    const res = await h.request(alice, "PUT", repoUrl(), { body });
    expect(res.statusCode).toBe(400);
    expect(await stored()).toEqual([]);
    // Whatever was sent, the error does not repeat it.
    expect(res.body).not.toContain(KEY);
    expect(res.body).not.toContain("sk-has a space");
  });

  it("is audited with provider and scope, never the key", async () => {
    await put(repoUrl());
    await put(installationUrl());
    const entries = (
      await listAuditLog(h.t.db, [world.alpha.installation.id], { action: "credential.put" })
    ).items;
    expect(entries.map((e) => [e.target, e.metadata])).toEqual(
      expect.arrayContaining([
        [`repo:${world.alpha.repo.id}`, { provider: "deepseek", scope: "repository" }],
        [
          `installation:${world.alpha.installation.id}`,
          { provider: "deepseek", scope: "installation" },
        ],
      ]),
    );
    expect(JSON.stringify(entries)).not.toContain(KEY);
    expect(JSON.stringify(entries)).not.toContain("WXYZ");
  });
});

describe("the key never leaks (AC-18)", () => {
  it("is absent from every response and every log line, including failures", async () => {
    const responses = [
      await put(repoUrl()),
      await put(repoUrl()),
      await h.request(alice, "GET", repoUrl()),
      await h.request(alice, "GET", installationUrl()),
      await h.request(alice, "GET", `/api/repos/${world.alpha.repo.id}/settings`),
      await h.request(alice, "GET", `/api/repos`),
      await h.request(alice, "GET", `/api/me`),
      await h.request(alice, "DELETE", `${repoUrl()}?provider=deepseek`),
      // Failures that carry the key in the request:
      await h.request(alice, "PUT", repoUrl(), {
        rawBody: `{"provider":"deepseek","api_key":"${KEY}`,
      }),
      await h.request(alice, "PUT", repoUrl(), { rawBody: `${KEY}` }),
      await h.request(alice, "PUT", repoUrl(), { body: { provider: "nope", api_key: KEY } }),
      await h.request(alice, "PUT", repoUrl(), {
        body: { provider: "deepseek", api_key: KEY, extra: 1 },
      }),
      await h.request(alice, "PUT", repoUrl(), {
        body: { provider: "deepseek", api_key: KEY },
        csrf: false,
      }),
      await h.request(undefined, "PUT", repoUrl(), {
        body: { provider: "deepseek", api_key: KEY },
      }),
      await h.request(alice, "PUT", `/api/repos/${world.beta.repo.id}/credentials`, {
        body: { provider: "deepseek", api_key: KEY },
      }),
    ];
    for (const res of responses) {
      expect(res.body).not.toContain(KEY);
      expect(res.body).not.toContain(KEY.slice(0, 16));
      expect(res.body.toLowerCase()).not.toContain("ciphertext");
      expect(JSON.stringify(res.headers)).not.toContain(KEY);
    }
    expect(h.logLines.join("\n")).not.toContain(KEY);
    expect(h.logLines.join("\n")).not.toContain(KEY.slice(0, 16));
  });

  it("is not in the database in the clear anywhere (credentials, audit log, sessions)", async () => {
    await put(repoUrl());
    const dump = await h.t.pool.query(
      `select (select coalesce(string_agg(t::text, ''), '') from provider_credentials t) ||
              (select coalesce(string_agg(t::text, ''), '') from audit_log t) ||
              (select coalesce(string_agg(t::text, ''), '') from repo_settings t) as everything`,
    );
    // `bytea` text form is hex, so check the key's hex too.
    expect(dump.rows[0].everything).not.toContain(KEY);
    expect(dump.rows[0].everything).not.toContain(Buffer.from(KEY).toString("hex"));
  });

  it("an unexpected server error shows no detail and logs only the error name", async () => {
    const original = h.probe.check;
    h.probe.check = async () => {
      throw new Error(`boom ${KEY}`);
    };
    let res;
    try {
      res = await h.request(alice, "POST", `${repoUrl()}/test`, {
        body: { provider: "deepseek", api_key: KEY },
      });
    } finally {
      h.probe.check = original;
    }
    expect(res.statusCode).toBe(500);
    expect(res.json().error).toMatchObject({ code: "internal_error", message: "Internal error" });
    expect(res.body).not.toContain(KEY);
    expect(h.logLines.join("\n")).not.toContain(KEY);
    expect(h.logLines.join("\n")).not.toContain("boom");
  });
});

describe("DELETE", () => {
  it("removes only the named provider at that scope", async () => {
    await put(repoUrl(), KEY, "deepseek");
    await put(repoUrl(), KEY, "openai");
    await put(installationUrl(), KEY, "deepseek");

    const res = await h.request(alice, "DELETE", `${repoUrl()}?provider=deepseek`);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true });
    const left = await stored();
    expect(left.map((r) => `${r.repo_id ? "repo" : "installation"}:${r.provider}`).sort()).toEqual([
      "installation:deepseek",
      "repo:openai",
    ]);
  });

  it("is a 404 when there is nothing to remove, and needs a valid provider", async () => {
    expect((await h.request(alice, "DELETE", `${repoUrl()}?provider=deepseek`)).statusCode).toBe(
      404,
    );
    expect((await h.request(alice, "DELETE", `${repoUrl()}?provider=skynet`)).statusCode).toBe(400);
    expect((await h.request(alice, "DELETE", repoUrl())).statusCode).toBe(400);
  });

  it("is audited", async () => {
    await put(installationUrl());
    await h.request(alice, "DELETE", `${installationUrl()}?provider=deepseek`);
    const entries = (
      await listAuditLog(h.t.db, [world.alpha.installation.id], { action: "credential.delete" })
    ).items;
    expect(entries[0]).toMatchObject({
      target: `installation:${world.alpha.installation.id}`,
      metadata: { provider: "deepseek", scope: "installation" },
    });
  });
});

describe("POST .../credentials/test", () => {
  const test = (api_key = KEY, provider = "deepseek", url = repoUrl()) =>
    h.request(alice, "POST", `${url}/test`, { body: { provider, api_key } });

  it("checks the key from the request with the provider's default endpoint and stores nothing", async () => {
    const res = await test();
    expect(res.json()).toEqual({ ok: true, message: "The provider accepted the key." });
    expect(h.probe.calls).toHaveLength(1);
    expect(h.probe.calls[0]).toMatchObject({ provider: "deepseek", apiKey: KEY });
    expect(h.probe.calls[0]!.baseUrl.toString()).toBe("https://api.deepseek.com/");
    expect(await stored()).toEqual([]);
    expect(res.body).not.toContain(KEY);
  });

  it("uses the configured base_url when it is for this provider", async () => {
    await h.request(alice, "PATCH", `/api/repos/${world.alpha.repo.id}/settings`, {
      body: { config: { provider: "deepseek", base_url: "https://llm.example.com/v1" } },
    });
    await test();
    expect(h.probe.calls[0]!.baseUrl.toString()).toBe("https://llm.example.com/v1");
    // Another provider keeps its own default.
    await test(KEY, "openai");
    expect(h.probe.calls[1]!.baseUrl.toString()).toBe("https://api.openai.com/v1");
  });

  it("never calls an endpoint that resolves to an internal address", async () => {
    h.dns.addresses = ["169.254.169.254"];
    const res = await test();
    expect(res.statusCode).toBe(200);
    expect(res.json().ok).toBe(false);
    expect(res.json().message).toContain("not allowed");
    expect(h.probe.calls).toEqual([]);
  });

  it("passes on a sanitised failure from the provider", async () => {
    h.probe.result = { ok: false, message: "The provider rejected the key." };
    try {
      expect((await test()).json()).toEqual({
        ok: false,
        message: "The provider rejected the key.",
      });
    } finally {
      h.probe.result = { ok: true, message: "The provider accepted the key." };
    }
  });

  it("is limited to ten calls a minute per user", async () => {
    const statuses: number[] = [];
    for (let i = 0; i < 12; i++) statuses.push((await test()).statusCode);
    expect(statuses.slice(0, 10).every((s) => s === 200)).toBe(true);
    expect(statuses.slice(10)).toEqual([429, 429]);
    h.clock.advance(61_000);
    expect((await test()).statusCode).toBe(200);
  });
});
