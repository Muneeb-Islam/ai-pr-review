import { describe, expect, it } from "vitest";
import { csvCell, csvRow, toCsv } from "./csv";

describe("csvCell", () => {
  it("leaves plain text and numbers alone and writes empty cells for nothing", () => {
    expect(csvCell("plain")).toBe("plain");
    expect(csvCell(42)).toBe("42");
    expect(csvCell(-3)).toBe("-3");
    expect(csvCell(true)).toBe("true");
    expect(csvCell(null)).toBe("");
    expect(csvCell(undefined)).toBe("");
  });

  it("quotes cells with commas, quotes and line breaks, doubling the quotes", () => {
    expect(csvCell("a,b")).toBe('"a,b"');
    expect(csvCell('say "hi"')).toBe('"say ""hi"""');
    expect(csvCell("two\nlines")).toBe('"two\nlines"');
    expect(csvCell("cr\rlf")).toBe('"\'cr\rlf"'.replace("'cr", "cr"));
  });

  it.each(["=SUM(A1)", "+1", "-1+2", "@cmd", "\tTab", "\rReturn"])(
    "makes %j text instead of a formula",
    (value) => {
      expect(csvCell(value).replace(/^"/, "")).toMatch(/^'/);
    },
  );

  it("does not touch a formula character in the middle of the text", () => {
    expect(csvCell("a=b")).toBe("a=b");
    expect(csvCell("risk: -5")).toBe("risk: -5");
  });
});

describe("toCsv", () => {
  it("writes a byte order mark, a header and CRLF-separated rows", () => {
    expect(
      toCsv(
        ["a", "b"],
        [
          [1, "x,y"],
          [2, null],
        ],
      ),
    ).toBe('﻿a,b\r\n1,"x,y"\r\n2,\r\n');
    expect(csvRow(["a", 1])).toBe("a,1");
  });
});
