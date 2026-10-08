// Settings API (PL-09): validation, merge semantics, base_url SSRF rules, enable/disable, installation defaults.
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

const repoUrl = () => `/api/repos/${world.alpha.repo.id}/settings`;
const installationUrl = () => `/api/installations/${world.alpha.installation.id}/settings`;
const patchRepo = (config: unknown, extra: Record<string, unknown> = {}, session = alice) =>
  h.request(session, "PATCH", repoUrl(), { body: { config, ...extra } });
const getRepo = async () => (await h.request(alice, "GET", repoUrl())).json();

beforeEach(async () => {
  h.dns.addresses = ["104.18.2.55"];
  // Start every test from empty settings.
  await h.t.pool.query("delete from repo_settings");
  await h.t.pool.query("delete from installation_settings");
  await h.t.pool.query("update repositories set enabled = true");
});

describe("GET /api/repos/:id/settings", () => {
  it("returns the effective configuration with defaults, nothing stored, no repo-file keys yet", async () => {
    const body = await getRepo();
    expect(body).toMatchObject({
      repo_id: world.alpha.repo.id,
      enabled: true,
      config: {},
      inherited: {},
      repo_file_keys: [],
      updated_at: null,
      updated_by: null,
    });
    expect(body.effective).toMatchObject({
      provider: null,
      model: null,
      base_url: null,
      fork_prs: "skip",
      review: {
        mode: "comment_only",
        minimum_confidence: 0.8,
        target_branches: ["main", "master"],
      },
      agents: { code_review: true, test_coverage: true, security: true, final_review: false },
      limits: { concurrency: 3, max_requests: 20 },
    });
  });

  it("a viewer can read it", async () => {
    expect((await h.request(victor, "GET", repoUrl())).statusCode).toBe(200);
  });
});

describe("PATCH /api/repos/:id/settings", () => {
  it("stores the provided keys only and returns the new effective configuration", async () => {
    const res = await patchRepo({
      provider: "deepseek",
      model: "deepseek-chat",
      review: { mode: "warn" },
      fork_prs: "review",
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.config).toEqual({
      provider: "deepseek",
      model: "deepseek-chat",
      review: { mode: "warn" },
      fork_prs: "review",
    });
    expect(body.effective).toMatchObject({
      provider: "deepseek",
      model: "deepseek-chat",
      fork_prs: "review",
      review: { mode: "warn", minimum_severity: "medium" },
    });
    expect(body.updated_by).toBe(alice.userId);
    expect(body.updated_at).not.toBeNull();
    expect(await getRepo()).toMatchObject({ config: body.config });
  });

  it("merges: nested mappings combine, arrays and scalars replace, null resets a key", async () => {
    await patchRepo({
      review: { mode: "warn", target_branches: ["main"] },
      instructions: "be kind",
    });
    await patchRepo({ review: { minimum_confidence: 0.9, target_branches: ["develop", "main"] } });
    expect((await getRepo()).config).toEqual({
      review: { mode: "warn", minimum_confidence: 0.9, target_branches: ["develop", "main"] },
      instructions: "be kind",
    });

    const reset = await patchRepo({ review: { mode: null }, instructions: null });
    expect(reset.json().config).toEqual({
      review: { minimum_confidence: 0.9, target_branches: ["develop", "main"] },
    });
    expect(reset.json().effective.review.mode).toBe("comment_only");

    // A section left empty disappears.
    const cleared = await patchRepo({ review: null });
    expect(cleared.json().config).toEqual({});
  });

  it.each([
    ["an unknown top-level key", { not_a_setting: 1 }, "not_a_setting: unknown key"],
    ["an unknown nested key", { review: { nope: true } }, "review.nope: unknown key"],
    ["a wrong type", { review: { max_inline_comments: "many" } }, "review.max_inline_comments"],
    ["an invalid enum value", { review: { mode: "yolo" } }, "review.mode"],
    ["a value out of range", { review: { minimum_confidence: 1.5 } }, "review.minimum_confidence"],
    ["an empty branch list", { review: { target_branches: [] } }, "review.target_branches"],
    ["an unknown provider", { provider: "skynet" }, "provider"],
    ["a non-URL base_url", { base_url: "not a url" }, "base_url"],
  ])(
    "rejects %s with the path of the problem and stores nothing",
    async (_name, config, problem) => {
      await patchRepo({ review: { mode: "warn" } });
      const before = await getRepo();
      const res = await patchRepo(config);
      expect(res.statusCode).toBe(400);
      expect(res.json().error.code).toBe("validation_error");
      expect(res.json().error.details.join("\n")).toContain(problem);
      expect((await getRepo()).config).toEqual(before.config);
    },
  );

  it("rejects unknown keys in the request itself and empty requests", async () => {
    const extra = await h.request(alice, "PATCH", repoUrl(), { body: { config: {}, admin: true } });
    expect(extra.statusCode).toBe(400);
    const none = await h.request(alice, "PATCH", repoUrl(), { body: {} });
    expect(none.statusCode).toBe(400);
    expect(none.json().error.details[0]).toContain("Nothing to update");
    const wrongType = await h.request(alice, "PATCH", repoUrl(), { body: { config: [1, 2] } });
    expect(wrongType.statusCode).toBe(400);
    const notJson = await h.request(alice, "PATCH", repoUrl(), { rawBody: "{nope" });
    expect(notJson.statusCode).toBe(400);
  });

  it("a viewer cannot change anything", async () => {
    const res = await patchRepo({ review: { mode: "fail_on_threshold" } }, {}, victor);
    expect(res.statusCode).toBe(403);
    expect((await getRepo()).config).toEqual({});
  });

  it("records the change in the audit log by key name, never by value", async () => {
    await patchRepo({ instructions: "secret-looking instruction text", review: { mode: "warn" } });
    const entries = (
      await listAuditLog(h.t.db, [world.alpha.installation.id], { action: "settings.update" })
    ).items;
    expect(entries[0]).toMatchObject({
      action: "settings.update",
      target: `repo:${world.alpha.repo.id}`,
      userId: alice.userId,
      metadata: { keys: ["instructions", "review"] },
    });
    expect(JSON.stringify(entries)).not.toContain("secret-looking");
  });
});

describe("enable and disable", () => {
  it("an admin can switch a repository off and on; the repository list shows it", async () => {
    const off = await h.request(alice, "PATCH", repoUrl(), { body: { enabled: false } });
    expect(off.statusCode).toBe(200);
    expect(off.json().enabled).toBe(false);
    const repo = (await h.request(alice, "GET", `/api/repos/${world.alpha.repo.id}`)).json();
    expect(repo.enabled).toBe(false);

    const on = await h.request(alice, "PATCH", repoUrl(), {
      body: { enabled: true, config: { fork_prs: "review" } },
    });
    expect(on.json()).toMatchObject({ enabled: true, config: { fork_prs: "review" } });
  });

  it("is audited", async () => {
    await h.request(alice, "PATCH", repoUrl(), { body: { enabled: false } });
    const entries = (
      await listAuditLog(h.t.db, [world.alpha.installation.id], { action: "settings.update" })
    ).items;
    expect(entries.some((e) => (e.metadata as { enabled?: boolean }).enabled === false)).toBe(true);
  });
});

describe("base_url (SSRF, design §6)", () => {
  const accepted = async (base_url: string) => (await patchRepo({ base_url })).statusCode;

  it("accepts a public HTTPS endpoint", async () => {
    const res = await patchRepo({ provider: "openai", base_url: "https://llm.example.com/v1" });
    expect(res.statusCode).toBe(200);
    expect(res.json().effective.base_url).toBe("https://llm.example.com/v1");
  });

  it.each([
    "http://llm.example.com/v1",
    "ftp://llm.example.com",
    "https://localhost/v1",
    "https://127.0.0.1/v1",
    "https://[::1]/v1",
    "https://169.254.169.254/latest/meta-data",
    "https://10.0.0.5/v1",
    "https://172.16.4.4/v1",
    "https://192.168.1.10:8443/v1",
    "https://100.64.0.1/v1",
    "https://2130706433/v1",
    "https://user:pass@llm.example.com/v1",
    "https://service.internal/v1",
  ])("rejects %s", async (url) => {
    const res = await patchRepo({ base_url: url });
    expect(res.statusCode, url).toBe(400);
    expect(res.json().error.details[0]).toMatch(/^base_url: /);
    expect((await getRepo()).config).toEqual({});
  });

  it.each([
    ["loopback", "127.0.0.1"],
    ["the cloud metadata address", "169.254.169.254"],
    ["a private range", "10.1.2.3"],
    ["a private IPv6 range", "fd00::1"],
  ])("rejects a hostname that resolves to %s", async (_name, address) => {
    h.dns.addresses = [address];
    expect(await accepted("https://totally-public.example.com/v1")).toBe(400);
    h.dns.addresses = ["104.18.2.55", address];
    expect(await accepted("https://totally-public.example.com/v1")).toBe(400);
    expect((await getRepo()).config).toEqual({});
  });

  it("does not echo what the hostname resolved to", async () => {
    h.dns.addresses = ["10.99.88.77"];
    const res = await patchRepo({ base_url: "https://totally-public.example.com/v1" });
    expect(res.body).not.toContain("10.99.88.77");
  });

  it("checks installation defaults the same way", async () => {
    const res = await h.request(alice, "PATCH", installationUrl(), {
      body: { config: { base_url: "https://169.254.169.254/" } },
    });
    expect(res.statusCode).toBe(400);
  });
});

describe("installation settings", () => {
  it("returns the defaults layer and read-only quotas", async () => {
    const res = await h.request(alice, "GET", installationUrl());
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      installation_id: world.alpha.installation.id,
      account_login: world.alpha.installation.accountLogin,
      config: {},
      quotas: { runs_per_day: 200, tokens_per_day: 2_000_000, read_only: true },
    });
  });

  it("quota values cannot be set", async () => {
    const res = await h.request(alice, "PATCH", installationUrl(), {
      body: { config: { quotas: { runs_per_day: 1_000_000 } } },
    });
    expect(res.statusCode).toBe(400);
    const direct = await h.request(alice, "PATCH", installationUrl(), {
      body: { config: {}, quotas: { runs_per_day: 1 } },
    });
    expect(direct.statusCode).toBe(400);
  });

  it("repositories inherit it, and their own settings win", async () => {
    const set = await h.request(alice, "PATCH", installationUrl(), {
      body: { config: { provider: "deepseek", model: "m-installation", review: { mode: "warn" } } },
    });
    expect(set.statusCode).toBe(200);

    let repo = await getRepo();
    expect(repo.inherited).toEqual({
      provider: "deepseek",
      model: "m-installation",
      review: { mode: "warn" },
    });
    expect(repo.config).toEqual({});
    expect(repo.effective).toMatchObject({
      provider: "deepseek",
      model: "m-installation",
      review: { mode: "warn" },
    });

    await patchRepo({ model: "m-repo", review: { mode: "comment_only" } });
    repo = await getRepo();
    expect(repo.effective).toMatchObject({
      provider: "deepseek",
      model: "m-repo",
      review: { mode: "comment_only" },
    });
    // The other repository of the installation still sees the installation values.
    const other = (
      await h.request(alice, "GET", `/api/repos/${world.alpha.repo2.id}/settings`)
    ).json();
    expect(other.effective).toMatchObject({ model: "m-installation", review: { mode: "warn" } });
  });

  it("is audited", async () => {
    await h.request(alice, "PATCH", installationUrl(), {
      body: { config: { provider: "openai" } },
    });
    const entries = (
      await listAuditLog(h.t.db, [world.alpha.installation.id], {
        action: "installation.settings.update",
      })
    ).items;
    expect(entries[0]).toMatchObject({ userId: alice.userId, metadata: { keys: ["provider"] } });
  });

  it("is admin only; a viewer can read", async () => {
    expect((await h.request(victor, "GET", installationUrl())).statusCode).toBe(200);
    const res = await h.request(victor, "PATCH", installationUrl(), {
      body: { config: { provider: "openai" } },
    });
    expect(res.statusCode).toBe(403);
  });
});
