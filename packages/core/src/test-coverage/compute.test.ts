import { describe, expect, it } from "vitest";
import { computeChangedCoverage, toRanges } from "./compute";
import { parseLcov } from "./lcov";
import { fixture } from "./fixtures";
import { lcovRecord } from "./test-support";

const changed = (path: string, ...ranges: Array<[number, number]>) => ({
  path,
  addedLines: ranges.map(([start, end]) => ({ start, end })),
});

describe("toRanges", () => {
  it("folds consecutive lines, sorts and de-duplicates", () => {
    expect(toRanges([5, 3, 4, 4, 9, 10, 20])).toEqual([
      { start: 3, end: 5 },
      { start: 9, end: 10 },
      { start: 20, end: 20 },
    ]);
    expect(toRanges([])).toEqual([]);
  });
});

describe("computeChangedCoverage: hand-computed fixtures", () => {
  // src/a.ts has executable lines 1-6 and 10-12; hits: 1,1,0,0,2,1 | 0,0,3.
  const report = parseLcov(
    lcovRecord("src/a.ts", [
      [1, 1],
      [2, 1],
      [3, 0],
      [4, 0],
      [5, 2],
      [6, 1],
      [10, 0],
      [11, 0],
      [12, 3],
    ]),
  );

  it("intersects added lines with executable lines", () => {
    // Added 2-4 and 10-11 => executable & changed: 2,3,4,10,11 (5 lines); covered: 2 only.
    const { summary } = computeChangedCoverage([changed("src/a.ts", [2, 4], [10, 11])], report);
    expect(summary.status).toBe("measured");
    expect(summary.coveredLines).toBe(1);
    expect(summary.totalLines).toBe(5);
    expect(summary.changedLineCoverage).toBeCloseTo(0.2);
    expect(summary.files).toEqual([
      {
        path: "src/a.ts",
        status: "measured",
        coveredLines: 1,
        totalLines: 5,
        uncovered: [
          { start: 3, end: 4 },
          { start: 10, end: 11 },
        ],
      },
    ]);
  });

  it("ignores changed lines the report does not count (comments, braces, types)", () => {
    // Added 7-9 are not in DA at all.
    const { summary } = computeChangedCoverage([changed("src/a.ts", [7, 9])], report);
    expect(summary.totalLines).toBe(0);
    expect(summary.changedLineCoverage).toBeUndefined();
    expect(summary.observations).toContain(
      "None of the changed lines in the report are executable code.",
    );
    expect(summary.files?.[0]).toMatchObject({
      status: "measured",
      totalLines: 0,
      coveredLines: 0,
    });
  });

  it("is 100% when every executable changed line ran", () => {
    const { summary } = computeChangedCoverage([changed("src/a.ts", [1, 2], [5, 6])], report);
    expect(summary.changedLineCoverage).toBe(1);
    expect(summary.files?.[0]?.uncovered).toEqual([]);
  });

  it("lists a changed file that is missing from the report as not in report, never as 0%", () => {
    const { summary } = computeChangedCoverage(
      [changed("src/a.ts", [1, 2]), changed("src/new.ts", [1, 40])],
      report,
    );
    expect(summary.files?.find((f) => f.path === "src/new.ts")).toEqual({
      path: "src/new.ts",
      status: "not_in_report",
      coveredLines: 0,
      totalLines: 0,
      uncovered: [],
    });
    // The percentage counts matched files only: 2 of 2 on a.ts, nothing from new.ts.
    expect(summary.changedLineCoverage).toBe(1);
    expect(summary.observations[0]).toContain("1 changed file is not in the coverage report");
  });

  it("sums over several files and orders the least covered first", () => {
    const two = parseLcov(
      [
        lcovRecord("src/good.ts", [
          [1, 1],
          [2, 1],
          [3, 1],
          [4, 1],
        ]),
        lcovRecord("src/bad.ts", [
          [1, 0],
          [2, 0],
          [3, 1],
          [4, 0],
        ]),
      ].join("\n"),
    );
    const { summary } = computeChangedCoverage(
      [
        changed("src/good.ts", [1, 4]),
        changed("src/bad.ts", [1, 4]),
        changed("src/gone.ts", [1, 2]),
      ],
      two,
    );
    expect(summary.coveredLines).toBe(5);
    expect(summary.totalLines).toBe(8);
    expect(summary.changedLineCoverage).toBeCloseTo(0.625);
    expect(summary.files?.map((f) => f.path)).toEqual(["src/bad.ts", "src/good.ts", "src/gone.ts"]);
  });

  it("names functions declared on changed lines that never ran, and counts changed branches", () => {
    const r = parseLcov(
      [
        "SF:src/f.ts",
        "FN:2,used",
        "FN:8,unused",
        "FN:20,farAway",
        "FNDA:3,used",
        "FNDA:0,unused",
        "FNDA:0,farAway",
        "DA:2,3",
        "DA:3,3",
        "DA:8,0",
        "DA:9,0",
        "BRDA:3,0,0,3",
        "BRDA:3,0,1,0",
        "BRDA:30,0,0,0",
        "end_of_record",
      ].join("\n"),
    );
    const { summary } = computeChangedCoverage([changed("src/f.ts", [1, 10])], r);
    const file = summary.files?.[0];
    expect(file?.uncoveredFunctions).toEqual(["unused"]); // farAway is not on a changed line
    expect(file?.coveredBranches).toBe(1);
    expect(file?.totalBranches).toBe(2);
  });

  it("maps Windows-style report paths to the repository's", () => {
    const { summary, pathRule } = computeChangedCoverage(
      [changed("src/math.js", [1, 20])],
      parseLcov(fixture("jest.lcov")),
    );
    expect(pathRule).toBe("same");
    // Jest fixture: executable lines 2,3,5,9,10,11,14,15,18 with hits 1,0,1,1,0,0,1,0,1 => 5 of 9.
    expect(summary.coveredLines).toBe(5);
    expect(summary.totalLines).toBe(9);
    expect(summary.files?.[0]?.uncovered).toEqual([
      { start: 3, end: 3 },
      { start: 10, end: 11 },
      { start: 15, end: 15 },
    ]);
    expect(summary.files?.[0]?.uncoveredFunctions).toEqual(["(anonymous_2)"]);
  });

  it("caps the uncovered ranges stored per file", () => {
    const lines: Array<[number, number]> = Array.from({ length: 120 }, (_, i) => [i * 2 + 1, 0]);
    const r = parseLcov(lcovRecord("src/big.ts", lines));
    const { summary } = computeChangedCoverage([changed("src/big.ts", [1, 300])], r);
    expect(summary.files?.[0]?.uncovered).toHaveLength(25);
    expect(summary.totalLines).toBe(120); // the counts are still exact
  });
});
