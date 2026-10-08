import { describe, expect, it } from "vitest";
import { inspectRepoFile, loadEffectiveConfig, parseRepoFile, readRepoFile } from "./repo-config";
import { createFakeGitHub, DASHBOARD } from "./test-support";

const repo = { owner: "acme", repo: "widgets" };
const BASE = "b".repeat(40);

const load = (setup: Parameters<typeof createFakeGitHub>[0], dashboard = DASHBOARD) => {
  const github = createFakeGitHub(setup);
  return loadEffectiveConfig({
    client: github.client,
    repo,
    baseSha: BASE,
    dashboard,
  }).then((result) => ({ ...result, calls: github.calls }));
};

describe("loadEffectiveConfig", () => {
  it("reads the file at the base SHA, never the head", async () => {
    const { calls } = await load({
      pull: { headSha: "h".repeat(40) },
      configFile: "review:\n  mode: warn\n",
    });
    const read = calls.find((c) => c.route === "GET /repos/{owner}/{repo}/contents/{path}");
    expect(read?.params).toMatchObject({ path: ".github/ai-pr-review.yml", ref: BASE });
    expect(JSON.stringify(calls)).not.toContain("h".repeat(40));
  });

  it("layers the file over the dashboard settings key by key", async () => {
    const { config, warnings } = await load(
      { configFile: "review:\n  mode: fail_on_threshold\nignore: [docs/**]\n" },
      { ...DASHBOARD, review: { mode: "warn", max_inline_comments: 5 }, fork_prs: "review" },
    );
    expect(warnings).toEqual([]);
    expect(config.review.mode).toBe("fail_on_threshold");
    expect(config.review.max_inline_comments).toBe(5);
    expect(config.fork_prs).toBe("review");
    expect(config.ignore).toEqual(["docs/**"]);
    expect(config.provider).toBe("deepseek");
  });

  it("uses the dashboard settings when the file is missing (404)", async () => {
    const { config, warnings } = await load({}, { ...DASHBOARD, review: { mode: "warn" } });
    expect(config.review.mode).toBe("warn");
    expect(warnings).toEqual([]);
  });

  it("ignores sensitive keys with a warning", async () => {
    const { config, warnings } = await load({
      configFile: [
        "provider: openai",
        "model: gpt-x",
        "base_url: https://evil.example.com",
        "limits: { max_requests: 9999 }",
        "review: { mode: warn }",
      ].join("\n"),
    });
    expect(config.provider).toBe("deepseek");
    expect(config.model).toBe("test-model");
    expect(config.base_url).toBeUndefined();
    expect(config.limits.max_requests).toBe(20);
    expect(config.review.mode).toBe("warn");
    expect(warnings).toHaveLength(4);
    expect(warnings.join("\n")).toMatch(/"provider" can only be set in the dashboard/);
  });

  it("falls back to the dashboard settings with a warning on invalid YAML", async () => {
    const { config, warnings } = await load(
      { configFile: "review: [unclosed" },
      { ...DASHBOARD, review: { mode: "warn" } },
    );
    expect(config.review.mode).toBe("warn");
    expect(warnings[0]).toMatch(/Invalid YAML/);
    expect(warnings[0]).toMatch(/Using the dashboard settings/);
  });

  it("falls back to the dashboard settings when the file fails schema validation", async () => {
    const { config, warnings } = await load({
      configFile: "review:\n  mode: nonsense\n  minimum_confidence: 3\nunknown_key: 1\n",
    });
    expect(config.review.mode).toBe("comment_only");
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatch(/review\.mode/);
    expect(warnings[0]).toMatch(/unknown_key: unknown key/);
  });

  it("treats an empty file as no settings", async () => {
    const { config, warnings } = await load({ configFile: "" });
    expect(config.review.mode).toBe("comment_only");
    expect(warnings).toEqual([]);
  });

  it("ignores an oversized file", async () => {
    const { warnings } = await load({ configFile: `ignore:\n${"  - a\n".repeat(20_000)}` });
    expect(warnings[0]).toMatch(/larger than 64 KB/);
  });

  it("propagates errors other than 404 so the job retries", async () => {
    await expect(
      load({ failures: { "GET /repos/{owner}/{repo}/contents": 502 } }),
    ).rejects.toMatchObject({
      status: 502,
    });
  });
});

describe("parseRepoFile", () => {
  it("returns the raw keys that passed validation", () => {
    expect(parseRepoFile("fork_prs: review\nagents: { security: false }")).toEqual({
      config: { fork_prs: "review", agents: { security: false } },
      warnings: [],
    });
  });
});

describe("inspectRepoFile", () => {
  it("says whether the file was usable", () => {
    expect(inspectRepoFile("fork_prs: review").valid).toBe(true);
    expect(inspectRepoFile("review: { mode: sometimes }").valid).toBe(false);
    expect(inspectRepoFile("review: [unterminated").valid).toBe(false);
  });

  it("treats a dashboard-only key as a warning, not as a broken file", () => {
    const result = inspectRepoFile("provider: openai\nfork_prs: review");
    expect(result.valid).toBe(true);
    expect(result.config).toEqual({ fork_prs: "review" });
    expect(result.warnings).toHaveLength(1);
  });
});

describe("readRepoFile (what the settings screen shows)", () => {
  const read = (setup: Parameters<typeof createFakeGitHub>[0]) => {
    const github = createFakeGitHub(setup);
    return readRepoFile({ client: github.client, repo, ref: BASE }).then((r) => ({
      ...r,
      calls: github.calls,
    }));
  };

  it("reads the file at the given branch and returns the settings it sets", async () => {
    const result = await read({ configFile: "review:\n  mode: warn\nignore: [docs/**]\n" });
    expect(result).toMatchObject({
      status: "applied",
      config: { review: { mode: "warn" }, ignore: ["docs/**"] },
      message: null,
    });
    expect(
      result.calls.find((c) => c.params?.["path"] === ".github/ai-pr-review.yml")?.params,
    ).toMatchObject({
      ref: BASE,
    });
  });

  it("reports a missing file as absent, not as an error", async () => {
    expect(await read({})).toMatchObject({ status: "absent", config: {}, message: null });
  });

  it("reports an unusable file as invalid with the reason, and sets nothing", async () => {
    const result = await read({ configFile: "review: { mode: sometimes }" });
    expect(result.status).toBe("invalid");
    expect(result.config).toEqual({});
    expect(result.message).toContain("review.mode");
  });

  it("keeps a note about ignored dashboard-only keys while applying the rest", async () => {
    const result = await read({ configFile: "model: gpt-x\nfork_prs: review" });
    expect(result).toMatchObject({ status: "applied", config: { fork_prs: "review" } });
    expect(result.message).toContain("model");
  });

  it("throws what GitHub throws, apart from 404, so the caller can say it is unavailable", async () => {
    await expect(
      read({ failures: { "GET /repos/{owner}/{repo}/contents": 502 } }),
    ).rejects.toMatchObject({ status: 502 });
  });
});
