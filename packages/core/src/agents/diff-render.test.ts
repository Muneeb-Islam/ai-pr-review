import { describe, expect, it } from "vitest";
import { estimateTokens } from "../context/size";
import { parsePatch } from "../context/diff";
import { MULTI_HUNK_PATCH, patch } from "../context/test-support";
import type { ChangedFile } from "../context/types";
import { chunkDiff } from "./diff-render";

function changed(
  path: string,
  patchText: string | undefined,
  over: Partial<ChangedFile> = {},
): ChangedFile {
  return {
    path,
    status: "modified",
    additions: 1,
    deletions: 0,
    addedLines: [],
    ...over,
    ...(patchText === undefined ? {} : { patch: patchText }),
  };
}

/** A hunk of `n` added lines of `width` characters, starting at line 1. */
const bigHunk = (n: number, width = 60) =>
  patch(
    `@@ -0,0 +1,${n} @@`,
    ...Array.from({ length: n }, (_, i) => `+${String(i + 1).padStart(width, "x")}`),
  );

describe("chunkDiff: rendering", () => {
  it("shows new-file line numbers on added and context lines, none on deleted lines", () => {
    const [chunk] = chunkDiff([changed("src/a.ts", MULTI_HUNK_PATCH)], 10_000);
    expect(chunk?.paths).toEqual(["src/a.ts"]);
    const lines = (chunk?.text ?? "").split("\n");
    expect(lines[0]).toBe("=== FILE: src/a.ts (modified, +1 -0) ===");
    expect(lines).toContain('    1   import a from "a";'); // context, line 1
    expect(lines).toContain("      - const x = 1;"); // deleted: no number
    expect(lines).toContain("    2 + const x = 2;"); // added, line 2
    expect(lines).toContain("    3 + const y = 3;");
    expect(lines).toContain("   22 +   b();"); // second hunk numbering
    expect(lines.some((line) => line.includes("No newline"))).toBe(false);
  });

  it("names the old path of a renamed file", () => {
    const [chunk] = chunkDiff(
      [
        changed("src/new.ts", patch("@@ -1,1 +1,1 @@", "-a", "+b"), {
          status: "renamed",
          previousPath: "src/old.ts",
        }),
      ],
      10_000,
    );
    expect(chunk?.text).toContain("renamed from src/old.ts");
  });

  it("skips files without a patch", () => {
    expect(chunkDiff([changed("img.png", undefined)], 10_000)).toEqual([]);
  });
});

describe("chunkDiff: sizing", () => {
  it("keeps whole files together while they fit and starts a new chunk when they do not", () => {
    const files = Array.from({ length: 6 }, (_, i) => changed(`src/f${i}.ts`, bigHunk(5)));
    const chunks = chunkDiff(files, 400);
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.flatMap((c) => c.paths).sort()).toEqual(files.map((f) => f.path).sort());
    for (const chunk of chunks) expect(chunk.tokens).toBeLessThanOrEqual(400);
    // No file is split when each fits on its own.
    for (const file of files) {
      expect(chunks.filter((c) => c.paths.includes(file.path))).toHaveLength(1);
    }
  });

  it("splits a big file across chunks by hunk and repeats the header", () => {
    const hunks = Array.from({ length: 4 }, (_, i) =>
      patch(`@@ -${i * 100 + 1},3 +${i * 100 + 1},4 @@`, " a", `+${"y".repeat(150)}`, " b", " c"),
    );
    const chunks = chunkDiff([changed("src/big.ts", hunks.join("\n"))], 200);
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks[0]?.text.split("\n")[0]).toBe("=== FILE: src/big.ts (modified, +1 -0) ===");
    expect(chunks[1]?.text.split("\n")[0]).toBe(
      "=== FILE: src/big.ts (modified, +1 -0) (continued) ===",
    );
    for (const chunk of chunks) expect(chunk.tokens).toBeLessThanOrEqual(200);
  });

  it("splits one oversized hunk by line windows without losing or repeating a line", () => {
    const file = changed("src/huge.ts", bigHunk(200, 80));
    const chunks = chunkDiff([file], 500);
    expect(chunks.length).toBeGreaterThan(3);
    for (const chunk of chunks) expect(estimateTokens(chunk.text)).toBeLessThanOrEqual(500);

    const seen = chunks
      .flatMap((c) => c.text.split("\n"))
      .map((line) => /^\s*(\d+) \+ /.exec(line)?.[1])
      .filter((n): n is string => n !== undefined)
      .map(Number);
    expect(seen).toEqual(Array.from({ length: 200 }, (_, i) => i + 1));
    // Windows are numbered correctly, so each is as valid as the whole hunk.
    const hunk = parsePatch(file.patch ?? "").hunks[0];
    expect(hunk?.lines.at(-1)?.newLine).toBe(200);
  });

  it("returns nothing for no files", () => {
    expect(chunkDiff([], 1000)).toEqual([]);
  });
});
