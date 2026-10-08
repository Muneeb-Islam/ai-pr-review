import { describe, expect, it } from "vitest";
import { LcovError, parseLcov } from "./lcov";
import { fixture } from "./fixtures";

describe("parseLcov: real reports", () => {
  // Both fixtures are untouched output of the tools (Jest 30 with istanbul, Vitest 5 with the v8 provider) run on
  // the same small module on Windows; the paths keep the backslashes the tools wrote.
  it("reads Jest output: files, line hits, functions and branches", () => {
    const report = parseLcov(fixture("jest.lcov"));
    expect(report.malformedLines).toBe(0);
    expect(report.files).toHaveLength(1);
    const file = report.files[0]!;
    expect(file.path).toBe("src\\math.js");
    expect([...file.lines.entries()]).toEqual([
      [2, 1],
      [3, 0],
      [5, 1],
      [9, 1],
      [10, 0],
      [11, 0],
      [14, 1],
      [15, 0],
      [18, 1],
    ]);
    expect(file.functions).toEqual([
      { name: "divide", line: 1, hits: 1 },
      { name: "clamp", line: 8, hits: 1 },
      { name: "(anonymous_2)", line: 14, hits: 0 },
    ]);
    // BRDA lines: 2 (one of two taken), 9 (one of two), 10 (none)
    expect(file.branches).toHaveLength(6);
    expect(file.branches.filter((b) => b.taken)).toHaveLength(2);
  });

  it("reads Vitest (v8) output", () => {
    const report = parseLcov(fixture("vitest-v8.lcov"));
    expect(report.files).toHaveLength(1);
    const file = report.files[0]!;
    expect(file.path).toBe("src\\math.js");
    expect(file.lines.get(14)).toBe(1);
    expect(file.lines.get(15)).toBe(0);
    expect(file.lines.has(18)).toBe(false); // v8 reports no line 18
    expect(file.functions.map((f) => f.name)).toEqual(["divide", "clamp", "(anonymous_2)"]);
  });
});

describe("parseLcov: shapes and edge cases", () => {
  it("reads several records, CRLF line endings and a checksum on DA", () => {
    const text = [
      "TN:",
      "SF:/ci/work/app/src/a.ts",
      "DA:1,5,abcdef",
      "DA:2,0",
      "LF:2",
      "LH:1",
      "end_of_record",
      "TN:",
      "SF:/ci/work/app/src/b.ts",
      "DA:7,1",
      "end_of_record",
      "",
    ].join("\r\n");
    const report = parseLcov(text);
    expect(report.files.map((f) => f.path)).toEqual([
      "/ci/work/app/src/a.ts",
      "/ci/work/app/src/b.ts",
    ]);
    expect(report.files[0]!.lines.get(1)).toBe(5);
  });

  it("keeps a record with no lines: the file is in the report with nothing executable", () => {
    const report = parseLcov("SF:src/types.ts\nend_of_record\n");
    expect(report.files).toHaveLength(1);
    expect(report.files[0]!.lines.size).toBe(0);
  });

  it("accepts the lcov 2 form of FN (with an end line) and names that contain commas", () => {
    const report = parseLcov(
      [
        "SF:a.ts",
        "FN:3,9,run",
        "FN:12,compare(a,b)",
        "FNDA:2,run",
        "FNDA:0,compare(a,b)",
        "end_of_record",
      ].join("\n"),
    );
    expect(report.files[0]!.functions).toEqual([
      { name: "run", line: 3, hits: 2 },
      { name: "compare(a,b)", line: 12, hits: 0 },
    ]);
  });

  it("treats a branch marked `-` as not taken", () => {
    const report = parseLcov("SF:a.ts\nBRDA:4,0,0,-\nBRDA:4,0,1,3\nend_of_record\n");
    expect(report.files[0]!.branches).toEqual([
      { line: 4, taken: false },
      { line: 4, taken: true },
    ]);
  });

  it("adds up the same file reported twice (merged reports)", () => {
    const text = [
      "SF:a.ts",
      "DA:1,1",
      "DA:2,0",
      "end_of_record",
      "SF:a.ts",
      "DA:1,2",
      "DA:2,4",
      "end_of_record",
    ].join("\n");
    const report = parseLcov(text);
    expect(report.files).toHaveLength(1);
    expect(report.files[0]!.lines.get(1)).toBe(3);
    expect(report.files[0]!.lines.get(2)).toBe(4);
  });

  it("counts lines it does not understand and carries on", () => {
    const text = ["SF:a.ts", "DA:x,1", "DA:3", "DA:4,-1", "DA:5,1", "ZZ:wat", "end_of_record"].join(
      "\n",
    );
    const report = parseLcov(text);
    expect(report.malformedLines).toBe(4);
    expect([...report.files[0]!.lines.entries()]).toEqual([[5, 1]]);
  });

  it("ignores absurd line numbers instead of trusting them", () => {
    const report = parseLcov("SF:a.ts\nDA:99999999999,1\nDA:2,1\nend_of_record\n");
    expect([...report.files[0]!.lines.keys()]).toEqual([2]);
    expect(report.malformedLines).toBe(1);
  });

  it("keeps a final record that has no end_of_record", () => {
    const report = parseLcov("SF:a.ts\nDA:1,1\n");
    expect(report.files).toHaveLength(1);
  });
});

describe("parseLcov: unusable input", () => {
  it.each(["", "   \n\n  "])("rejects an empty report (%j)", (text) => {
    expect(() => parseLcov(text)).toThrowError(LcovError);
    try {
      parseLcov(text);
    } catch (err) {
      expect((err as LcovError).code).toBe("empty");
    }
  });

  it.each([
    ["an HTML page", "<!doctype html><html><body>Coverage</body></html>"],
    ["JSON", '{"total":{"lines":{"pct":100}}}'],
    ["a binary blob", "\u0000\u0001\u0002 not lcov"],
    ["records with no SF", "DA:1,1\nDA:2,0\nend_of_record\n"],
  ])("rejects %s as not LCOV", (_name, text) => {
    try {
      parseLcov(text);
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(LcovError);
      expect((err as LcovError).code).toBe("invalid");
    }
  });

  it("never puts the report text in an error message", () => {
    try {
      parseLcov("super-secret-token-12345 is not lcov");
    } catch (err) {
      expect((err as Error).message).not.toContain("super-secret");
    }
  });

  it("refuses a report with more files than the cap", () => {
    const text = Array.from({ length: 5 }, (_, i) => `SF:f${i}.ts\nDA:1,1\nend_of_record`).join(
      "\n",
    );
    try {
      parseLcov(text, { maxFiles: 3 });
      expect.unreachable();
    } catch (err) {
      expect((err as LcovError).code).toBe("too_many_files");
    }
  });
});
