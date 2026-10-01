import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ConfigError, loadConfig, parseConfigYaml, resolveConfig } from "../src/config/loader";

let workspace: string;

beforeEach(() => {
  workspace = mkdtempSync(path.join(tmpdir(), "aipr-config-"));
});
afterEach(() => {
  rmSync(workspace, { recursive: true, force: true });
});

function writeConfig(yaml: string, rel = ".github/ai-pr-review.yml") {
  const file = path.join(workspace, rel);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, yaml);
}

const load = (inputs = {}, configPath = ".github/ai-pr-review.yml") =>
  loadConfig({ workspace, configPath, inputs });

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
    writeConfig("provider: anthropic\nmodel: m1\nreview:\n  minimum_confidence: 0.9\n");
    const { config, filePath } = load();
    expect(filePath).toBe(path.join(workspace, ".github/ai-pr-review.yml"));
    expect(config.provider).toBe("anthropic");
    expect(config.model).toBe("m1");
    expect(config.review.minimum_confidence).toBe(0.9);
    // sibling defaults in the same section survive
    expect(config.review.minimum_severity).toBe("medium");
    expect(config.review.max_changed_files).toBe(40);
  });

  it("accepts every provider and an optional base_url", () => {
    for (const provider of ["anthropic", "openai", "deepseek"]) {
      writeConfig(`provider: ${provider}\nmodel: m\nbase_url: https://api.example.com/v1\n`);
      const { config } = load();
      expect(config.provider).toBe(provider);
      expect(config.base_url).toBe("https://api.example.com/v1");
    }
  });

  it("treats a blank `base_url:` as unset", () => {
    writeConfig("provider: deepseek\nmodel: m\nbase_url:\n");
    expect(load().config.base_url).toBeUndefined();
  });

  it("parses the shipped example config", () => {
    const text = readFileSync(path.join(__dirname, "..", "examples", "ai-pr-review.yml"), "utf8");
    const config = resolveConfig(parseConfigYaml(text, "examples/ai-pr-review.yml"));
    expect(config.provider).toBe("deepseek");
    expect(config.review.mode).toBe("comment_only");
  });
});

describe("config: defaults (missing file)", () => {
  it("uses defaults when the file does not exist and inputs supply provider+model", () => {
    const { config, filePath } = load({ provider: "deepseek", model: "m" });
    expect(filePath).toBeUndefined();
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
    expect(config.coverage.lcov_path).toBe("coverage/lcov.info");
    expect(config.fork_prs).toBe("skip");
    expect(config.ignore).toEqual(["dist/**", "coverage/**", "**/*.lock"]);
  });

  it("an empty file behaves like a missing one", () => {
    writeConfig("");
    expect(load({ provider: "openai", model: "m" }).config.provider).toBe("openai");
  });

  it("still requires provider and model when there is no file", () => {
    const err = configError(() => load());
    expect(err.problems).toEqual(expect.arrayContaining(["provider: required", "model: required"]));
  });
});

describe("config: invalid values", () => {
  it("names the offending nested key", () => {
    writeConfig("provider: deepseek\nmodel: m\nreview:\n  minimum_confidence: 1.5\n");
    expect(configError(() => load()).message).toContain("review.minimum_confidence");
  });

  it("rejects an unknown provider and names the key", () => {
    writeConfig("provider: gemini\nmodel: m\n");
    expect(configError(() => load()).problems[0]).toMatch(/^provider:/);
  });

  it("rejects unknown top-level and nested keys, naming them", () => {
    writeConfig("provider: deepseek\nmodel: m\nbogus: 1\nreview:\n  nope: true\n");
    const { problems } = configError(() => load());
    expect(problems).toContain("bogus: unknown key");
    expect(problems).toContain("review.nope: unknown key");
  });

  it("rejects wrong types and non-positive limits", () => {
    writeConfig(
      "provider: deepseek\nmodel: m\nagents:\n  security: yes please\nlimits:\n  concurrency: 0\n",
    );
    const { problems } = configError(() => load());
    expect(problems.some((p) => p.startsWith("agents.security:"))).toBe(true);
    expect(problems.some((p) => p.startsWith("limits.concurrency:"))).toBe(true);
  });

  it("rejects bad enum values for mode and severity", () => {
    writeConfig("provider: deepseek\nmodel: m\nreview:\n  mode: block\n  minimum_severity: huge\n");
    const { problems } = configError(() => load());
    expect(problems.some((p) => p.startsWith("review.mode:"))).toBe(true);
    expect(problems.some((p) => p.startsWith("review.minimum_severity:"))).toBe(true);
  });

  it("rejects an invalid base_url", () => {
    writeConfig("provider: deepseek\nmodel: m\nbase_url: not a url\n");
    expect(configError(() => load()).problems[0]).toMatch(/^base_url:/);
  });

  it("reports malformed YAML and non-mapping documents readably", () => {
    writeConfig("provider: [unclosed\n");
    expect(configError(() => load()).message).toContain("Invalid YAML");
    writeConfig("- just\n- a list\n");
    expect(configError(() => load()).message).toContain("YAML mapping");
  });

  it("lists every problem, not just the first", () => {
    writeConfig("provider: nope\nmodel: 5\n");
    expect(configError(() => load()).problems.length).toBeGreaterThanOrEqual(2);
  });

  it("refuses a config_path that escapes the workspace", () => {
    expect(configError(() => load({}, "../outside.yml")).message).toContain("inside the workspace");
  });
});

describe("config: precedence (inputs > file > defaults)", () => {
  beforeEach(() => {
    writeConfig(
      "provider: anthropic\nmodel: file-model\nbase_url: https://file.example.com\nreview:\n  mode: warn\n  minimum_severity: high\n",
    );
  });

  it("inputs override file values", () => {
    const { config } = load({
      provider: "deepseek",
      model: "input-model",
      baseUrl: "https://input.example.com",
      mode: "fail_on_threshold",
    });
    expect(config.provider).toBe("deepseek");
    expect(config.model).toBe("input-model");
    expect(config.base_url).toBe("https://input.example.com");
    expect(config.review.mode).toBe("fail_on_threshold");
  });

  it("the mode input overrides only review.mode, keeping the rest of review", () => {
    const { config } = load({ mode: "comment_only" });
    expect(config.review.mode).toBe("comment_only");
    expect(config.review.minimum_severity).toBe("high");
  });

  it("empty inputs fall through to the file", () => {
    const { config } = load({ provider: "", model: "", baseUrl: "", mode: "" });
    expect(config.provider).toBe("anthropic");
    expect(config.model).toBe("file-model");
    expect(config.review.mode).toBe("warn");
  });

  it("file values override defaults", () => {
    expect(load().config.review.minimum_severity).toBe("high");
  });

  it("an invalid input value is still validated", () => {
    expect(configError(() => load({ provider: "gemini" })).problems[0]).toMatch(/^provider:/);
  });

  it("supports a custom config_path", () => {
    writeConfig("provider: openai\nmodel: alt\n", "conf/alt.yml");
    expect(load({}, "conf/alt.yml").config.model).toBe("alt");
  });
});
