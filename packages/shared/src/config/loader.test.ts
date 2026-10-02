import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { ConfigError, mergeConfig, parseConfigYaml, type RawConfig } from "./loader";

const dashboardDefault: RawConfig = { provider: "deepseek", model: "m" };

/** Dashboard settings + the text of an optional `.github/ai-pr-review.yml`. */
const load = (yaml?: string, dashboard: RawConfig = dashboardDefault) =>
  mergeConfig(dashboard, yaml === undefined ? {} : parseConfigYaml(yaml));

function configError(fn: () => unknown): ConfigError {
  try {
    fn();
  } catch (err) {
    expect(err).toBeInstanceOf(ConfigError);
    return err as ConfigError;
  }
  throw new Error("expected ConfigError");
}

describe("config: valid file", () => {
  it("loads a file and applies defaults for everything omitted", () => {
    const config = load("review:\n  minimum_confidence: 0.9\n", {
      provider: "anthropic",
      model: "m1",
    });
    expect(config.provider).toBe("anthropic");
    expect(config.model).toBe("m1");
    expect(config.review.minimum_confidence).toBe(0.9);
    // sibling defaults in the same section survive
    expect(config.review.minimum_severity).toBe("medium");
    expect(config.review.max_changed_files).toBe(40);
  });

  it("accepts every provider and an optional base_url", () => {
    for (const provider of ["anthropic", "openai", "deepseek"]) {
      const config = load(undefined, {
        provider,
        model: "m",
        base_url: "https://api.example.com/v1",
      });
      expect(config.provider).toBe(provider);
      expect(config.base_url).toBe("https://api.example.com/v1");
    }
  });

  it("treats a blank `base_url:` as unset", () => {
    expect(load(undefined, { ...dashboardDefault, base_url: null }).base_url).toBeUndefined();
  });

  it("parses the shipped example config", () => {
    const text = readFileSync(
      new URL("../../../../examples/ai-pr-review.yml", import.meta.url),
      "utf8",
    );
    const config = load(text);
    expect(config.review.mode).toBe("comment_only");
    expect(config.coverage.artifact_name).toBe("coverage");
  });
});

describe("config: defaults (missing file)", () => {
  it("uses defaults when the file does not exist and the dashboard supplies provider+model", () => {
    const config = load();
    expect(config.review).toEqual({
      mode: "comment_only",
      target_branches: ["main", "master"],
      draft_behavior: "summary_only",
      minimum_severity: "medium",
      minimum_confidence: 0.8,
      max_changed_files: 40,
      max_patch_characters: 120000,
      max_inline_comments: 20,
    });
    expect(config.agents).toEqual({
      code_review: true,
      test_coverage: true,
      security: true,
      final_review: false,
    });
    expect(config.limits.concurrency).toBe(3);
    expect(config.coverage).toEqual({ artifact_name: "coverage", lcov_path: "lcov.info" });
    expect(config.fork_prs).toBe("skip");
    expect(config.ignore).toEqual(["dist/**", "coverage/**", "**/*.lock"]);
  });

  it("an empty file behaves like a missing one", () => {
    expect(load("", { provider: "openai", model: "m" }).provider).toBe("openai");
  });

  it("still requires provider and model when there is no file", () => {
    const err = configError(() => load(undefined, {}));
    expect(err.problems).toEqual(expect.arrayContaining(["provider: required", "model: required"]));
  });
});

describe("config: invalid values", () => {
  it("names the offending nested key", () => {
    expect(configError(() => load("review:\n  minimum_confidence: 1.5\n")).message).toContain(
      "review.minimum_confidence",
    );
  });

  it("rejects an unknown provider and names the key", () => {
    expect(
      configError(() => load(undefined, { provider: "gemini", model: "m" })).problems[0],
    ).toMatch(/^provider:/);
  });

  it("rejects unknown top-level and nested keys, naming them", () => {
    const { problems } = configError(() => load("bogus: 1\nreview:\n  nope: true\n"));
    expect(problems).toContain("bogus: unknown key");
    expect(problems).toContain("review.nope: unknown key");
  });

  it("rejects wrong types and non-positive limits", () => {
    const { problems } = configError(() =>
      load("agents:\n  security: yes please\n", {
        ...dashboardDefault,
        limits: { concurrency: 0 },
      }),
    );
    expect(problems.some((p) => p.startsWith("agents.security:"))).toBe(true);
    expect(problems.some((p) => p.startsWith("limits.concurrency:"))).toBe(true);
  });

  it("rejects bad enum values for mode and severity", () => {
    const { problems } = configError(() =>
      load("review:\n  mode: block\n  minimum_severity: huge\n"),
    );
    expect(problems.some((p) => p.startsWith("review.mode:"))).toBe(true);
    expect(problems.some((p) => p.startsWith("review.minimum_severity:"))).toBe(true);
  });

  it("rejects an invalid base_url", () => {
    const err = configError(() => load(undefined, { ...dashboardDefault, base_url: "not a url" }));
    expect(err.problems[0]).toMatch(/^base_url:/);
  });

  it("reports malformed YAML and non-mapping documents readably", () => {
    expect(configError(() => load("review: [unclosed\n")).message).toContain("Invalid YAML");
    expect(configError(() => load("- just\n- a list\n")).message).toContain("YAML mapping");
  });

  it("lists every problem, not just the first", () => {
    expect(
      configError(() => load(undefined, { provider: "nope", model: 5 })).problems.length,
    ).toBeGreaterThanOrEqual(2);
  });

  it("rejects the removed read_only fork policy", () => {
    expect(configError(() => load("fork_prs: read_only\n")).problems[0]).toMatch(/^fork_prs:/);
  });
});

describe("config: precedence (defaults < dashboard < repo file)", () => {
  const dashboard: RawConfig = {
    provider: "anthropic",
    model: "dash-model",
    base_url: "https://dash.example.com",
    review: { mode: "warn", minimum_severity: "high" },
    fork_prs: "review",
  };

  it("the repo file overrides dashboard values for shared keys", () => {
    const config = load("review:\n  mode: fail_on_threshold\nfork_prs: skip\n", dashboard);
    expect(config.review.mode).toBe("fail_on_threshold");
    expect(config.fork_prs).toBe("skip");
  });

  it("a repo-file review key overrides only that key, keeping the other dashboard review keys", () => {
    const config = load("review:\n  mode: comment_only\n", dashboard);
    expect(config.review.mode).toBe("comment_only");
    expect(config.review.minimum_severity).toBe("high");
  });

  it("an empty repo file falls through to the dashboard", () => {
    const config = load("", dashboard);
    expect(config.provider).toBe("anthropic");
    expect(config.model).toBe("dash-model");
    expect(config.review.mode).toBe("warn");
  });

  it("dashboard values override defaults", () => {
    expect(load(undefined, dashboard).review.minimum_severity).toBe("high");
  });

  it("an invalid repo file value is still validated", () => {
    expect(configError(() => load("fork_prs: maybe\n", dashboard)).problems[0]).toMatch(
      /^fork_prs:/,
    );
  });

  it("arrays from the repo file replace dashboard arrays instead of merging", () => {
    const config = load("ignore: ['build/**']\n", { ...dashboard, ignore: ["dist/**", "x/**"] });
    expect(config.ignore).toEqual(["build/**"]);
  });
});

describe("config: dashboard-only keys", () => {
  it.each(["provider: openai", "model: other", "base_url: https://x.example.com", "limits: {}"])(
    "rejects `%s` in the repo file, naming the key",
    (line) => {
      const key = line.split(":")[0]!;
      const err = configError(() => load(`${line}\n`));
      expect(err.problems).toEqual([
        `${key}: dashboard-only setting; not allowed in .github/ai-pr-review.yml`,
      ]);
    },
  );

  it("reports every dashboard-only key found, and does not apply the file", () => {
    const err = configError(() => load("provider: openai\nmodel: x\nlimits:\n  concurrency: 99\n"));
    expect(err.problems.map((p) => p.split(":")[0])).toEqual(["provider", "model", "limits"]);
  });
});
