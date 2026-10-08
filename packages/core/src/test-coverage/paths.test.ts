import { describe, expect, it } from "vitest";
import type { LcovFile } from "./lcov";
import { matchReportFiles, normalizeReportPath } from "./paths";

const record = (path: string, hits = 1): LcovFile => ({
  path,
  lines: new Map([[1, hits]]),
  functions: [],
  branches: [],
});

describe("normalizeReportPath", () => {
  it.each([
    ["src/a.ts", "src/a.ts"],
    ["src\\a.ts", "src/a.ts"],
    ["./src/a.ts", "src/a.ts"],
    [".\\src\\a.ts", "src/a.ts"],
    ["src//a.ts", "src/a.ts"],
    ["src/./a.ts", "src/a.ts"],
    ["src/lib/../a.ts", "src/a.ts"],
    ["/home/runner/work/app/app/src/a.ts", "/home/runner/work/app/app/src/a.ts"],
    ["D:\\a\\app\\app\\src\\a.ts", "D:/a/app/app/src/a.ts"],
    ["file:///home/runner/app/src/a.ts", "/home/runner/app/src/a.ts"],
    ["file:///C:/a/app/src/a.ts", "C:/a/app/src/a.ts"],
    ["  src/a.ts  ", "src/a.ts"],
    ["../outside/a.ts", "../outside/a.ts"],
  ])("%s -> %s", (raw, expected) => {
    expect(normalizeReportPath(raw)).toBe(expected);
  });
});

describe("matchReportFiles", () => {
  it("matches paths written the same way as the repository's", () => {
    const m = matchReportFiles(["src/a.ts", "src/b.ts"], [record("src/a.ts"), record("src/c.ts")]);
    expect([...m.matched.keys()]).toEqual(["src/a.ts"]);
    expect(m.unmatched).toEqual(["src/b.ts"]);
    expect(m.rule).toBe("same");
  });

  it("matches Windows separators and a ./ prefix", () => {
    const m = matchReportFiles(
      ["src/a.ts", "src/lib/b.ts"],
      [record("src\\a.ts"), record(".\\src\\lib\\b.ts")],
    );
    expect(m.unmatched).toEqual([]);
  });

  it("strips the workspace root of a CI runner (absolute paths)", () => {
    const m = matchReportFiles(
      ["src/a.ts", "src/lib/b.ts"],
      [
        record("/home/runner/work/app/app/src/a.ts"),
        record("/home/runner/work/app/app/src/lib/b.ts"),
        record("/home/runner/work/app/app/src/other.ts"),
      ],
    );
    expect(m.unmatched).toEqual([]);
    expect(m.rule).toBe("strip:/home/runner/work/app/app/");
  });

  it("strips a Windows runner's drive path", () => {
    const m = matchReportFiles(["src/a.ts"], [record("D:\\a\\app\\app\\src\\a.ts")]);
    expect(m.matched.has("src/a.ts")).toBe(true);
  });

  it("adds the package prefix when the report is relative to a package in a monorepo", () => {
    const m = matchReportFiles(
      ["packages/web/src/a.ts", "packages/web/src/b.ts"],
      [record("src/a.ts"), record("src/b.ts")],
    );
    expect(m.unmatched).toEqual([]);
    expect(m.rule).toBe("add:packages/web/");
  });

  it("does not guess when two packages could own the report", () => {
    // `src/index.ts` could belong to either package: matching one would show the other's coverage.
    const m = matchReportFiles(
      ["packages/a/src/index.ts", "packages/b/src/index.ts"],
      [record("src/index.ts")],
    );
    expect(m.matched.size).toBe(0);
    expect(m.unmatched).toHaveLength(2);
  });

  it("prefers the exact spelling when another checkout's absolute path ends the same way", () => {
    const m = matchReportFiles(
      ["src/a.ts"],
      [record("/ci/one/src/a.ts", 7), record("/ci/two/src/a.ts", 8), record("src/a.ts", 9)],
    );
    expect(m.rule).toBe("same");
    expect(m.matched.get("src/a.ts")?.lines.get(1)).toBe(9);
  });

  it("does not match a file whose name only ends the same way", () => {
    const m = matchReportFiles(["a.ts"], [record("src/data.ts"), record("src/beta.ts")]);
    expect(m.matched.size).toBe(0);
    expect(m.unmatched).toEqual(["a.ts"]);
  });

  it("merges two spellings of one path instead of dropping a record", () => {
    const m = matchReportFiles(["src/a.ts"], [record("src/a.ts", 2), record("src\\a.ts", 3)]);
    expect(m.matched.get("src/a.ts")?.lines.get(1)).toBe(5);
  });

  it("reports everything as unmatched for an empty report", () => {
    const m = matchReportFiles(["src/a.ts"], []);
    expect(m.unmatched).toEqual(["src/a.ts"]);
  });
});
