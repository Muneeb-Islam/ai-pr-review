import { describe, expect, it } from "vitest";
import { addedLineRanges, DiffIndex, parsePatch } from "./diff";
import { ADDED_PATCH, MULTI_HUNK_PATCH, REMOVED_PATCH, RENAMED_PATCH, patch } from "./test-support";

describe("parsePatch", () => {
  it("maps added lines of a new file to new-file numbers and positions", () => {
    const { hunks } = parsePatch(ADDED_PATCH);
    expect(hunks).toHaveLength(1);
    expect(hunks[0]?.lines.map((l) => [l.type, l.newLine, l.position])).toEqual([
      ["add", 1, 1],
      ["add", 2, 2],
      ["add", 3, 3],
    ]);
  });

  it("numbers multiple hunks, counting later hunk headers as positions", () => {
    const { hunks } = parsePatch(MULTI_HUNK_PATCH);
    expect(hunks).toHaveLength(2);
    const adds = hunks.flatMap((h) => h.lines.filter((l) => l.type === "add"));
    expect(adds.map((l) => [l.newLine, l.position])).toEqual([
      [2, 3],
      [3, 4],
      [22, 9],
    ]);
    const deleted = hunks[0]?.lines.find((l) => l.type === "del");
    expect(deleted).toMatchObject({ oldLine: 2, position: 2 });
    expect(hunks[1]?.heading).toBe("function foo() {");
  });

  it("keeps the no-newline marker as a meta line that has no line number", () => {
    const last = parsePatch(MULTI_HUNK_PATCH).hunks[1]?.lines.at(-1);
    expect(last).toMatchObject({ type: "meta", position: 12 });
    expect(last?.newLine).toBeUndefined();
  });

  it("handles deletions: no added lines", () => {
    const diff = parsePatch(REMOVED_PATCH);
    expect(diff.hunks[0]?.lines.every((l) => l.type === "del")).toBe(true);
    expect(addedLineRanges(diff)).toEqual([]);
  });

  it("handles a rename with content changes", () => {
    const diff = parsePatch(RENAMED_PATCH);
    expect(addedLineRanges(diff)).toEqual([{ start: 2, end: 2 }]);
  });

  it("reads single-line hunk headers without a count", () => {
    const { hunks } = parsePatch(patch("@@ -5 +5 @@", "-a", "+b"));
    expect(hunks[0]).toMatchObject({ oldStart: 5, oldLines: 1, newStart: 5, newLines: 1 });
  });

  it("copes with CRLF, a trailing newline and an empty patch", () => {
    expect(addedLineRanges(parsePatch("@@ -1 +1 @@\r\n-a\r\n+b\r\n"))).toEqual([
      { start: 1, end: 1 },
    ]);
    expect(parsePatch("").hunks).toEqual([]);
  });

  it("does not mistake an added line that looks like a hunk header for one", () => {
    const { hunks } = parsePatch(patch("@@ -1,1 +1,2 @@", " a", "+@@ -9,9 +9,9 @@"));
    expect(hunks).toHaveLength(1);
    expect(addedLineRanges({ hunks })).toEqual([{ start: 2, end: 2 }]);
  });
});

describe("addedLineRanges", () => {
  it("merges consecutive added lines, including across a deletion", () => {
    const diff = parsePatch(patch("@@ -1,3 +1,4 @@", " a", "+b", "-c", "+d", " e"));
    expect(addedLineRanges(diff)).toEqual([{ start: 2, end: 3 }]);
  });

  it("keeps separate runs separate", () => {
    expect(addedLineRanges(parsePatch(MULTI_HUNK_PATCH))).toEqual([
      { start: 2, end: 3 },
      { start: 22, end: 22 },
    ]);
  });
});

describe("DiffIndex", () => {
  const index = new DiffIndex();
  index.add("src/a.ts", MULTI_HUNK_PATCH);
  index.add("src/gone.ts", REMOVED_PATCH);
  index.add("src/binary.png", undefined);

  it("accepts only added lines (not context or deleted lines)", () => {
    expect(index.isLineInDiff("src/a.ts", 2)).toBe(true);
    expect(index.isLineInDiff("src/a.ts", 3)).toBe(true);
    expect(index.isLineInDiff("src/a.ts", 22)).toBe(true);
    expect(index.isLineInDiff("src/a.ts", 1)).toBe(false); // context
    expect(index.isLineInDiff("src/a.ts", 21)).toBe(false); // context
    expect(index.isLineInDiff("src/a.ts", 99)).toBe(false);
  });

  it("rejects unknown files, deleted files and files without a patch", () => {
    expect(index.isLineInDiff("src/other.ts", 1)).toBe(false);
    expect(index.isLineInDiff("src/gone.ts", 1)).toBe(false);
    expect(index.isLineInDiff("src/binary.png", 1)).toBe(false);
  });

  it("reports diff positions", () => {
    expect(index.position("src/a.ts", 3)).toBe(4);
    expect(index.position("src/a.ts", 22)).toBe(9);
    expect(index.position("src/a.ts", 1)).toBeUndefined();
  });

  it("accepts a range only when both ends are added lines of one hunk", () => {
    expect(index.isRangeInDiff("src/a.ts", 2, 3)).toBe(true);
    expect(index.isRangeInDiff("src/a.ts", 3, 2)).toBe(false);
    expect(index.isRangeInDiff("src/a.ts", 2, 22)).toBe(false); // different hunks
    expect(index.isRangeInDiff("src/a.ts", 2, 4)).toBe(false); // 4 is context
  });
});
