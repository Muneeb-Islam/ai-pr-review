import { describe, expect, it } from "vitest";
import { applySizePolicy, estimateFilesTokens, estimateTokens, type SizeCandidate } from "./size";
import type { ChangedFile } from "./types";

const candidate = (path: string, chars: number, priority = 0): SizeCandidate => {
  const file: ChangedFile = {
    path,
    status: "modified",
    additions: 1,
    deletions: 0,
    patch: "x".repeat(chars),
    addedLines: [],
  };
  return { file, priority };
};

describe("applySizePolicy (FR-09)", () => {
  it("is ok when everything fits", () => {
    const result = applySizePolicy({
      candidates: [candidate("a.ts", 10), candidate("b.ts", 10)],
      maxChangedFiles: 5,
      maxPatchCharacters: 100,
    });
    expect(result.limits).toEqual({ status: "ok" });
    expect(result.included).toHaveLength(2);
    expect(result.skipped).toEqual([]);
  });

  it("limits by file count, keeping source and tests ahead of config and docs", () => {
    const candidates = [
      candidate("README.md", 10, 3),
      candidate("tsconfig.json", 10, 2),
      candidate("src/a.test.ts", 10, 1),
      candidate("src/a.ts", 10, 0),
      candidate("src/b.ts", 10, 0),
    ];
    const result = applySizePolicy({ candidates, maxChangedFiles: 3, maxPatchCharacters: 1000 });
    expect(result.limits.status).toBe("limited");
    expect(result.included.map((f) => f.path)).toEqual(["src/a.test.ts", "src/a.ts", "src/b.ts"]);
    expect(result.skipped.map((s) => s.path).sort()).toEqual(["README.md", "tsconfig.json"]);
    expect(result.limits.reason).toMatch(/Reviewed 3 of 5 files, source and tests first/);
  });

  it("limits by patch size and lets a smaller file fit after one that does not", () => {
    const candidates = [
      candidate("big.ts", 80),
      candidate("mid.ts", 60),
      candidate("small.ts", 20),
    ];
    const result = applySizePolicy({ candidates, maxChangedFiles: 10, maxPatchCharacters: 100 });
    expect(result.limits.status).toBe("limited");
    expect(result.included.map((f) => f.path)).toEqual(["big.ts", "small.ts"]);
    expect(result.skipped).toEqual([
      { path: "mid.ts", reason: "over the patch size limit of 100 characters" },
    ]);
  });

  it("skips a single file whose patch alone is over the limit, and says so", () => {
    const result = applySizePolicy({
      candidates: [candidate("huge.ts", 150), candidate("a.ts", 10)],
      maxChangedFiles: 10,
      maxPatchCharacters: 100,
    });
    expect(result.included.map((f) => f.path)).toEqual(["a.ts"]);
    expect(result.skipped[0]?.reason).toMatch(/larger than the limit/);
  });

  it("skips the whole review when nothing fits", () => {
    const result = applySizePolicy({
      candidates: [candidate("huge.ts", 500)],
      maxChangedFiles: 10,
      maxPatchCharacters: 100,
    });
    expect(result.limits.status).toBe("skipped");
    expect(result.limits.reason).toMatch(/too large to review reliably/);
    expect(result.included).toEqual([]);
    expect(result.skipped).toHaveLength(1);
  });

  it("skips the whole review when far over the limit", () => {
    const candidates = Array.from({ length: 30 }, (_, i) => candidate(`f${i}.ts`, 1));
    const result = applySizePolicy({ candidates, maxChangedFiles: 5, maxPatchCharacters: 1000 });
    expect(result.limits.status).toBe("skipped");
    expect(result.limits.reason).toContain("30 files changed (limit 5)");
  });

  it("picks by priority then path, and keeps the original order of what it keeps", () => {
    const candidates = [candidate("c.ts", 10), candidate("a.ts", 10), candidate("b.ts", 10)];
    const result = applySizePolicy({ candidates, maxChangedFiles: 2, maxPatchCharacters: 1000 });
    expect(result.included.map((f) => f.path)).toEqual(["a.ts", "b.ts"]);
    expect(result.skipped.map((s) => s.path)).toEqual(["c.ts"]);
  });
});

describe("token estimation", () => {
  it("over-estimates slightly and grows with length", () => {
    expect(estimateTokens("")).toBe(0);
    expect(estimateTokens("a".repeat(35))).toBe(10);
    expect(estimateTokens("a".repeat(36))).toBe(11);
  });

  it("counts paths, patches and framing for a set of files", () => {
    const tokens = estimateFilesTokens([{ path: "a.ts", patch: "x".repeat(70) }, { path: "b.ts" }]);
    expect(tokens).toBeGreaterThan(20);
  });
});
