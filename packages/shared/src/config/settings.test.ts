import { describe, expect, it } from "vitest";
import {
  applyConfigPatch,
  ConfigError,
  resolveEffectiveSettings,
  validateDashboardConfig,
} from "./loader";

describe("applyConfigPatch", () => {
  it("merges mappings key by key and replaces arrays and scalars", () => {
    const stored = { review: { mode: "warn", target_branches: ["main"] }, fork_prs: "skip" };
    const next = applyConfigPatch(stored, {
      review: { minimum_confidence: 0.9, target_branches: ["dev"] },
      fork_prs: "review",
    });
    expect(next).toEqual({
      review: { mode: "warn", minimum_confidence: 0.9, target_branches: ["dev"] },
      fork_prs: "review",
    });
  });

  it("removes a key on null and drops mappings that become empty", () => {
    expect(
      applyConfigPatch({ review: { mode: "warn" }, model: "m" }, { review: { mode: null } }),
    ).toEqual({
      model: "m",
    });
    expect(applyConfigPatch({ a: 1 }, { a: null, b: null })).toEqual({});
    // Nulls inside a brand new mapping are not stored.
    expect(applyConfigPatch({}, { review: { mode: null, minimum_confidence: 0.5 } })).toEqual({
      review: { minimum_confidence: 0.5 },
    });
  });

  it("does not modify its inputs", () => {
    const stored = { review: { mode: "warn" } };
    const patch = { review: { mode: null } };
    applyConfigPatch(stored, patch);
    expect(stored).toEqual({ review: { mode: "warn" } });
    expect(patch).toEqual({ review: { mode: null } });
  });
});

describe("validateDashboardConfig", () => {
  it("accepts any subset of the config, including dashboard-only keys", () => {
    expect(validateDashboardConfig({}).ok).toBe(true);
    expect(
      validateDashboardConfig({ provider: "deepseek", model: "m", limits: { concurrency: 2 } }).ok,
    ).toBe(true);
  });

  it("reports unknown keys and bad values by path", () => {
    const result = validateDashboardConfig({ nope: 1, review: { mode: "x", nope2: true } });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.problems).toEqual(
        expect.arrayContaining(["nope: unknown key", "review.nope2: unknown key"]),
      );
      expect(result.problems.some((p) => p.startsWith("review.mode"))).toBe(true);
    }
  });
});

describe("resolveEffectiveSettings", () => {
  it("applies built-in defaults when nothing is set", () => {
    const effective = resolveEffectiveSettings();
    expect(effective.provider).toBeNull();
    expect(effective.model).toBeNull();
    expect(effective.base_url).toBeNull();
    expect(effective.review.mode).toBe("comment_only");
    expect(effective.limits.concurrency).toBe(3);
    expect(effective.fork_prs).toBe("skip");
  });

  it("layers from lowest to highest priority", () => {
    const effective = resolveEffectiveSettings(
      {
        provider: "deepseek",
        model: "installation-model",
        review: { mode: "warn", minimum_confidence: 0.7 },
      },
      { model: "repo-model", review: { mode: "fail_on_threshold" }, limits: { concurrency: 1 } },
    );
    expect(effective).toMatchObject({
      provider: "deepseek",
      model: "repo-model",
      review: { mode: "fail_on_threshold", minimum_confidence: 0.7 },
      limits: { concurrency: 1, max_requests: 20 },
    });
  });

  it("throws ConfigError with paths for invalid layers", () => {
    expect(() => resolveEffectiveSettings({ review: { mode: "nope" } })).toThrow(ConfigError);
    expect(() => resolveEffectiveSettings({ limits: { concurrency: -1 } })).toThrow(
      /limits\.concurrency/,
    );
  });
});
