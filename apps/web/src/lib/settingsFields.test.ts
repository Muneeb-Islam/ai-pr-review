import { configSchema } from "@ai-pr-review/shared/api";
import { describe, expect, it } from "vitest";
import { makeSettings } from "../test/insightFixtures";
import {
  ALL_FIELDS,
  applyPatch,
  buildPatch,
  changedPaths,
  FIELD_GROUPS,
  getIn,
  initialValues,
  isDirty,
  PROVIDER_LABELS,
  SCHEMA_ENUMS,
  setIn,
  validatePatch,
  type FormBase,
  type FormState,
} from "./settingsFields";

const effective = makeSettings().effective;
const stored = { provider: "deepseek", model: "m-1", review: { mode: "warn" } };

const baseOf = (o: Partial<FormBase> = {}): FormBase => ({
  values: initialValues(effective),
  stored,
  locked: new Set(),
  ...o,
});
const stateOf = (
  changes: Record<string, string | boolean> = {},
  resets: string[] = [],
): FormState => ({
  values: { ...initialValues(effective), ...changes },
  resets: new Set(resets),
});

describe("the field list", () => {
  it("covers each setting once", () => {
    const paths = ALL_FIELDS.map((f) => f.path);
    expect(new Set(paths).size).toBe(paths.length);
    expect(FIELD_GROUPS.every((g) => g.fields.length > 0)).toBe(true);
  });

  it("only names settings the shared schema knows", () => {
    // The schema fills in every default, so each setting has a value there (the custom endpoint is optional).
    const defaults = configSchema.parse({ provider: "deepseek", model: "m" }) as Record<
      string,
      unknown
    >;
    for (const field of ALL_FIELDS.filter((f) => f.path !== "base_url")) {
      expect(getIn(defaults, field.path), field.path).not.toBeUndefined();
    }
  });

  it("offers every value the schema accepts and no other", () => {
    const options = (path: string) =>
      ALL_FIELDS.find((f) => f.path === path)!
        .options!.map((o) => o.value)
        .filter(Boolean);
    expect(options("review.mode").sort()).toEqual([...SCHEMA_ENUMS.MODES].sort());
    expect(options("review.draft_behavior").sort()).toEqual(
      [...SCHEMA_ENUMS.DRAFT_BEHAVIORS].sort(),
    );
    expect(options("fork_prs").sort()).toEqual([...SCHEMA_ENUMS.FORK_PR_POLICIES].sort());
    expect(options("provider").sort()).toEqual([...SCHEMA_ENUMS.PROVIDERS].sort());
    expect(options("review.minimum_severity").sort()).toEqual([...SCHEMA_ENUMS.SEVERITIES].sort());
    expect(Object.keys(PROVIDER_LABELS).sort()).toEqual([...SCHEMA_ENUMS.PROVIDERS].sort());
  });

  it("starts from a configuration the schema accepts", () => {
    const result = validatePatch(
      {},
      buildPatch(baseOf({ stored: {} }), stateOf({ "review.minimum_confidence": "0.9" })),
    );
    expect(result).toEqual({ byField: {}, general: [] });
  });
});

describe("initialValues", () => {
  it("shows the effective value of each kind of field", () => {
    const v = initialValues(effective);
    expect(v["review.mode"]).toBe("warn");
    expect(v["review.minimum_confidence"]).toBe("0.8");
    expect(v["review.target_branches"]).toBe("main\nmaster");
    expect(v["agents.security"]).toBe(true);
    expect(v["agents.final_review"]).toBe(false);
    expect(v["instructions"]).toBe("");
    expect(v["limits.max_total_tokens"]).toBe("400000");
    expect(v["provider"]).toBe("deepseek");
  });

  it("shows an unset provider as empty", () => {
    expect(initialValues({ ...effective, provider: null, model: null })["provider"]).toBe("");
  });
});

describe("setIn / getIn / applyPatch", () => {
  it("sets and removes nested values without touching the original", () => {
    const original = { review: { mode: "warn", max_changed_files: 5 } };
    expect(setIn(original, "review.mode", "comment_only")).toEqual({
      review: { mode: "comment_only", max_changed_files: 5 },
    });
    expect(original.review.mode).toBe("warn");
    expect(setIn({ review: { mode: "warn" } }, "review.mode", undefined)).toEqual({});
    expect(getIn(original, "review.max_changed_files")).toBe(5);
    expect(getIn(original, "agents.security")).toBeUndefined();
  });

  it("applies a patch the way the api does: values replace, null removes", () => {
    expect(applyPatch(stored, { review: { mode: "fail_on_threshold" }, model: null })).toEqual({
      provider: "deepseek",
      review: { mode: "fail_on_threshold" },
    });
  });
});

describe("what counts as a change", () => {
  it("is nothing for an untouched form", () => {
    expect(changedPaths(baseOf(), stateOf())).toEqual([]);
    expect(isDirty(baseOf(), stateOf())).toBe(false);
  });

  it("is a field whose value differs, a reset, or the enabled switch", () => {
    expect(changedPaths(baseOf(), stateOf({ "review.mode": "comment_only" }))).toEqual([
      "review.mode",
    ]);
    expect(changedPaths(baseOf(), stateOf({}, ["review.mode"]))).toEqual(["review.mode"]);
    expect(isDirty({ ...baseOf(), enabled: true }, { ...stateOf(), enabled: false })).toBe(true);
  });

  it("never counts a field the repository file locks", () => {
    const base = baseOf({ locked: new Set(["review.mode"]) });
    expect(changedPaths(base, stateOf({ "review.mode": "comment_only" }))).toEqual([]);
  });
});

describe("buildPatch", () => {
  it("sends only what changed, nested", () => {
    expect(
      buildPatch(baseOf(), stateOf({ "review.mode": "comment_only", "agents.final_review": true })),
    ).toEqual({
      review: { mode: "comment_only" },
      agents: { final_review: true },
    });
  });

  it("turns multi-line fields into lists, trimming and dropping blank lines", () => {
    expect(buildPatch(baseOf(), stateOf({ ignore: "dist/**\n  docs/**  \n\n" }))).toEqual({
      ignore: ["dist/**", "docs/**"],
    });
  });

  it("turns numbers into numbers", () => {
    expect(buildPatch(baseOf(), stateOf({ "review.max_inline_comments": "7" }))).toEqual({
      review: { max_inline_comments: 7 },
    });
  });

  it("removes a stored setting on reset, and sends nothing for a reset of one that is not stored", () => {
    expect(buildPatch(baseOf(), stateOf({}, ["review.mode"]))).toEqual({ review: { mode: null } });
    expect(buildPatch(baseOf(), stateOf({}, ["review.max_changed_files"]))).toEqual({});
  });

  it("removes a stored optional text that was cleared, and an unset provider", () => {
    expect(buildPatch(baseOf(), stateOf({ model: "", provider: "" }))).toEqual({
      model: null,
      provider: null,
    });
  });

  it("does not store an empty optional text that was never stored", () => {
    expect(buildPatch(baseOf({ stored: {} }), stateOf({ base_url: "" }))).toEqual({});
    expect(buildPatch(baseOf({ stored: {} }), stateOf({ base_url: "   " }))).toEqual({});
  });
});

describe("validatePatch", () => {
  const problems = (changes: Record<string, string | boolean>) =>
    validatePatch(stored, buildPatch(baseOf(), stateOf(changes)));

  it("accepts a valid change", () => {
    expect(problems({ "review.minimum_confidence": "0.5" })).toEqual({ byField: {}, general: [] });
  });

  it("files a schema problem under its field", () => {
    const result = problems({ "review.minimum_confidence": "1.5" });
    expect(Object.keys(result.byField)).toEqual(["review.minimum_confidence"]);
    expect(result.general).toEqual([]);
  });

  it("files a problem inside a list under the list field", () => {
    const result = problems({ "review.target_branches": "" });
    expect(Object.keys(result.byField)).toEqual(["review.target_branches"]);
  });

  it("rejects a number that is not a number and a non-integer count", () => {
    expect(Object.keys(problems({ "review.max_inline_comments": "abc" }).byField)).toEqual([
      "review.max_inline_comments",
    ]);
    expect(Object.keys(problems({ "limits.max_requests": "2.5" }).byField)).toEqual([
      "limits.max_requests",
    ]);
    expect(Object.keys(problems({ "limits.max_requests": "0" }).byField)).toEqual([
      "limits.max_requests",
    ]);
  });

  it("rejects an empty required text", () => {
    expect(Object.keys(problems({ "coverage.artifact_name": "" }).byField)).toEqual([
      "coverage.artifact_name",
    ]);
  });

  it("checks the config as it would be stored, not only the change", () => {
    const result = validatePatch({ ...stored, mystery: 1 }, {});
    expect(result.general.join(" ")).toContain("mystery");
  });
});
