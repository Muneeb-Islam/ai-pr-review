import { findingSchema } from "@ai-pr-review/shared";
import { describe, expect, it } from "vitest";
import { buildContext, makeFinding } from "../agents/test-support";
import { ADDED_PATCH, file, makeConfig, MULTI_HUNK_PATCH, patch } from "../context/test-support";
import { fingerprintMarker } from "../context/markers";
import { compareFindings, dedupeByFingerprint } from "./dedupe";
import { fingerprintFinding, normalizeTitle } from "./fingerprint";
import {
  countSuppressed,
  isStyleOnly,
  validateFindings,
  type ValidationResult,
} from "./findingValidator";
import { createAgentJsonSchema, createAgentOutputSchema } from "./findingSchema";
import { isStrictCompatible } from "../providers/schema";

describe("fingerprint (design §12)", () => {
  const base = {
    category: "bug",
    title: "Missing await",
    filePath: "src/a.ts",
    startLine: 12,
  } as const;

  it("is 16 hex characters and stable", () => {
    const id = fingerprintFinding(base);
    expect(id).toMatch(/^[0-9a-f]{16}$/);
    expect(fingerprintFinding({ ...base })).toBe(id);
  });

  it("ignores case, punctuation and spacing of the title", () => {
    expect(fingerprintFinding({ ...base, title: "  missing  AWAIT!! " })).toBe(
      fingerprintFinding(base),
    );
    expect(normalizeTitle("Foo-bar: baz()")).toBe("foo bar baz");
  });

  it("stays the same within a five-line bucket and changes across it", () => {
    expect(fingerprintFinding({ ...base, startLine: 10 })).toBe(
      fingerprintFinding({ ...base, startLine: 14 }),
    );
    expect(fingerprintFinding({ ...base, startLine: 15 })).not.toBe(
      fingerprintFinding({ ...base, startLine: 14 }),
    );
  });

  it("depends on file, category and title", () => {
    const id = fingerprintFinding(base);
    expect(fingerprintFinding({ ...base, filePath: "src/b.ts" })).not.toBe(id);
    expect(fingerprintFinding({ ...base, category: "performance" })).not.toBe(id);
    expect(fingerprintFinding({ ...base, title: "Another problem" })).not.toBe(id);
  });

  it("copes with a finding that has no file or line", () => {
    expect(fingerprintFinding({ category: "bug", title: "General" })).toMatch(/^[0-9a-f]{16}$/);
  });
});

describe("dedupeByFingerprint", () => {
  it("keeps the most severe, then most confident, of equal fingerprints", () => {
    const weak = makeFinding({ id: "aaaaaaaaaaaaaaaa", severity: "medium", confidence: 0.95 });
    const strong = makeFinding({ id: "aaaaaaaaaaaaaaaa", severity: "high", confidence: 0.81 });
    const { unique, duplicates } = dedupeByFingerprint([weak, strong]);
    expect(unique).toEqual([strong]);
    expect(duplicates).toEqual([weak]);
  });

  it("treats fingerprints already posted on the PR as duplicates", () => {
    const f = makeFinding({ id: "bbbbbbbbbbbbbbbb" });
    expect(dedupeByFingerprint([f], ["bbbbbbbbbbbbbbbb"]).duplicates).toEqual([f]);
  });

  it("orders by severity, confidence, then place", () => {
    const list = [
      makeFinding({ id: "1", severity: "low", confidence: 0.99 }),
      makeFinding({ id: "2", severity: "critical", confidence: 0.8 }),
      makeFinding({ id: "3", severity: "high", confidence: 0.9, filePath: "b.ts" }),
      makeFinding({ id: "4", severity: "high", confidence: 0.9, filePath: "a.ts" }),
    ];
    expect([...list].sort(compareFindings).map((f) => f.id)).toEqual(["2", "4", "3", "1"]);
  });
});

describe("validateFindings (FR-19)", () => {
  const config = makeConfig({ provider: "deepseek", model: "m" });

  async function run(
    findings: ReturnType<typeof makeFinding>[],
    options: { prior?: string[]; config?: ReturnType<typeof makeConfig> } = {},
  ): Promise<ValidationResult> {
    const context = await buildContext(
      [file("src/a.ts"), file("src/multi.ts", MULTI_HUNK_PATCH, { status: "modified" })],
      {
        setup: {
          reviewComments: (options.prior ?? []).map((fp, i) => ({
            id: i + 1,
            body: `text\n${fingerprintMarker(fp, "c".repeat(40))}`,
          })),
        },
      },
    );
    return validateFindings(findings, context, options.config ?? config);
  }

  const reasons = (result: ValidationResult) => result.suppressed.map((s) => s.reason);
  const onLine = (line: number, over = {}) =>
    makeFinding({ filePath: "src/a.ts", startLine: line, endLine: line, ...over });

  it("accepts a finding on an added line with evidence and impact", async () => {
    const result = await run([onLine(2)]);
    expect(result.accepted).toHaveLength(1);
    expect(result.suppressed).toEqual([]);
    expect(findingSchema.safeParse(result.accepted[0]).success).toBe(true);
  });

  it("drops a finding whose file is not in the diff, or whose line is not an added line", async () => {
    const result = await run([
      makeFinding({ id: "1", filePath: "src/other.ts", startLine: 1, endLine: 1 }),
      onLine(99, { id: "2" }),
      onLine(2, { id: "3", startLine: undefined }), // an end line without a start
      makeFinding({ id: "4", filePath: undefined, startLine: 2 }), // a line without a file
    ]);
    expect(result.accepted).toEqual([]);
    expect(reasons(result)).toEqual([
      "invalid_line",
      "invalid_line",
      "invalid_line",
      "invalid_line",
    ]);
  });

  it("does not accept context or deleted lines (FR-17)", async () => {
    // MULTI_HUNK_PATCH: line 1 is context, line 2 and 3 are added.
    const result = await run([
      makeFinding({ id: "1", filePath: "src/multi.ts", startLine: 1, endLine: 1 }),
      makeFinding({ id: "2", filePath: "src/multi.ts", startLine: 2, endLine: 2, title: "ok" }),
    ]);
    expect(result.accepted.map((f) => f.id)).toEqual(["2"]);
    expect(result.suppressed[0]?.reason).toBe("invalid_line");
  });

  it("narrows a range whose end is not in the same hunk instead of dropping the finding", async () => {
    const result = await run([
      makeFinding({ filePath: "src/multi.ts", startLine: 3, endLine: 22, title: "Range" }),
    ]);
    expect(result.accepted).toHaveLength(1);
    expect(result.accepted[0]).toMatchObject({ startLine: 3, endLine: 3 });
  });

  it("keeps a valid multi-line range", async () => {
    const result = await run([onLine(1, { endLine: 3 })]);
    expect(result.accepted[0]).toMatchObject({ startLine: 1, endLine: 3 });
  });

  it("keeps a general finding with no file and no line", async () => {
    const result = await run([makeFinding({ id: "g" })]);
    expect(result.accepted.map((f) => f.id)).toEqual(["g"]);
  });

  it("keeps a file-level finding with no line", async () => {
    const result = await run([makeFinding({ filePath: "src/a.ts" })]);
    expect(result.accepted).toHaveLength(1);
  });

  it("requires evidence and a real impact", async () => {
    const result = await run([
      onLine(2, { id: "1", evidence: "  " }),
      onLine(2, { id: "2", impact: "" }),
      onLine(2, { id: "3", impact: "No impact." }),
      onLine(2, { id: "4", impact: "n/a" }),
    ]);
    expect(reasons(result)).toEqual(["no_evidence", "no_evidence", "no_evidence", "no_evidence"]);
  });

  it("suppresses style-only and linter findings, but never real defects", async () => {
    expect(
      isStyleOnly(makeFinding({ category: "maintainability", title: "Missing semicolon" })),
    ).toBe(true);
    expect(
      isStyleOnly(
        makeFinding({ category: "maintainability", title: "Violates the eslint no-var rule" }),
      ),
    ).toBe(true);
    expect(
      isStyleOnly(
        makeFinding({ category: "maintainability", title: "Inconsistent naming convention" }),
      ),
    ).toBe(true);
    // The same words on a bug are a real problem: ASI really can change behaviour.
    expect(
      isStyleOnly(
        makeFinding({ category: "bug", title: "Missing semicolon changes the return value" }),
      ),
    ).toBe(false);
    expect(
      isStyleOnly(
        makeFinding({
          category: "maintainability",
          title: "Duplicated retry logic must stay in sync",
        }),
      ),
    ).toBe(false);

    const result = await run([
      onLine(2, { category: "maintainability", title: "Use single quotes", severity: "high" }),
    ]);
    expect(reasons(result)).toEqual(["style_only"]);
  });

  it("applies the configured minimum severity and confidence", async () => {
    const result = await run([
      onLine(1, { id: "low", severity: "low", confidence: 0.99, title: "a" }),
      onLine(2, { id: "unsure", severity: "high", confidence: 0.79, title: "b" }),
      onLine(3, { id: "ok", severity: "medium", confidence: 0.8, title: "c" }),
    ]);
    expect(result.accepted.map((f) => f.id)).toEqual(["ok"]);
    expect(reasons(result)).toEqual(["below_threshold", "below_threshold"]);

    const lax = await run([onLine(1, { id: "low", severity: "info", confidence: 0.3 })], {
      config: makeConfig({
        provider: "deepseek",
        model: "m",
        review: { minimum_severity: "info", minimum_confidence: 0.2 },
      }),
    });
    expect(lax.accepted).toHaveLength(1);
  });

  it("deduplicates within a run, but keeps a finding that earlier comments already say (the publisher does not repost it)", async () => {
    const a = onLine(2, { id: "abababababababab", title: "x" });
    const b = onLine(3, { id: "abababababababab", title: "y", severity: "medium" });
    const result = await run([a, b, onLine(1, { id: "fedcba9876543210", title: "z" })], {
      prior: ["fedcba9876543210"],
    });
    expect(result.accepted.map((f) => f.id).sort()).toEqual([
      "abababababababab",
      "fedcba9876543210",
    ]);
    expect(result.accepted.find((f) => f.id === "abababababababab")?.severity).toBe("high");
    expect(reasons(result)).toEqual(["duplicate"]);
  });

  it("does not let a dropped finding hide a good one with the same fingerprint", async () => {
    const bad = onLine(99, { id: "same0same0same00" });
    const good = onLine(2, { id: "same0same0same00" });
    const result = await run([bad, good]);
    expect(result.accepted).toEqual([good]);
    expect(reasons(result)).toEqual(["invalid_line"]);
  });

  it("counts suppressed findings by reason, every reason present", async () => {
    const result = await run([
      onLine(99, { id: "1" }),
      onLine(98, { id: "2" }),
      onLine(1, { id: "3", evidence: "" }),
    ]);
    expect(countSuppressed(result.suppressed)).toEqual({
      below_threshold: 0,
      invalid_line: 2,
      no_evidence: 1,
      duplicate: 0,
      style_only: 0,
      rejected_by_final_review: 0,
    });
  });

  it("returns accepted findings most severe first", async () => {
    const result = await run([
      onLine(1, { id: "m", severity: "medium", title: "m" }),
      onLine(2, { id: "c", severity: "critical", title: "c" }),
    ]);
    expect(result.accepted.map((f) => f.id)).toEqual(["c", "m"]);
  });

  it("ignores removed files and files the diff does not contain", async () => {
    const context = await buildContext([
      file("src/gone.ts", patch("@@ -1,2 +0,0 @@", "-a", "-b"), { status: "removed" }),
      file("src/new.ts", ADDED_PATCH),
    ]);
    const result = validateFindings(
      [makeFinding({ filePath: "src/gone.ts", startLine: 1, endLine: 1 })],
      context,
      config,
    );
    expect(reasons(result)).toEqual(["invalid_line"]);
  });
});

describe("model output schema", () => {
  const categories = ["bug", "performance", "maintainability"] as const;

  it("is acceptable to OpenAI's strict mode and lists every field", () => {
    const schema = createAgentJsonSchema(categories) as {
      properties: {
        findings: { items: { required: string[]; properties: Record<string, unknown> } };
      };
    };
    expect(isStrictCompatible(schema)).toBe(true);
    const item = schema.properties.findings.items;
    expect(item.required.sort()).toEqual(Object.keys(item.properties).sort());
  });

  it("parses a full answer and tolerates missing nullable fields and extra keys", () => {
    const parser = createAgentOutputSchema(categories);
    const good = parser.safeParse({
      findings: [
        {
          category: "bug",
          severity: "high",
          confidence: 0.9,
          title: "t",
          evidence: "e",
          impact: "i",
          recommendation: "r",
          extra: true,
        },
      ],
    });
    expect(good.success).toBe(true);
  });

  it.each([
    ["wrong category", { category: "security" }],
    ["unknown severity", { severity: "blocker" }],
    ["confidence above 1", { confidence: 90 }],
    ["empty title", { title: "  " }],
    ["fractional line", { start_line: 1.5 }],
    ["missing evidence", { evidence: undefined }],
  ])("rejects %s", (_name, override) => {
    const parser = createAgentOutputSchema(categories);
    const finding = {
      category: "bug",
      severity: "high",
      confidence: 0.9,
      title: "t",
      evidence: "e",
      impact: "i",
      recommendation: "r",
      ...override,
    };
    expect(parser.safeParse({ findings: [finding] }).success).toBe(false);
  });

  it("rejects a non-object answer", () => {
    const parser = createAgentOutputSchema(categories);
    expect(parser.safeParse("not json {").success).toBe(false);
    expect(parser.safeParse(null).success).toBe(false);
    expect(parser.safeParse([]).success).toBe(false);
  });
});
