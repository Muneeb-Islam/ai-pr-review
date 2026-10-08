import { describe, expect, it } from "vitest";
import { formatDuration, formatRelative, shortSha } from "./format";

describe("formatDuration", () => {
  it.each([
    [0, "0 s"],
    [-5, "0 s"],
    [Number.NaN, "0 s"],
    [420, "420 ms"],
    [3_000, "3 s"],
    [72_000, "1 m 12 s"],
    [120_000, "2 m"],
    [3_900_000, "1 h 5 m"],
    [7_200_000, "2 h"],
  ])("%d ms is %s", (ms, text) => {
    expect(formatDuration(ms)).toBe(text);
  });
});

describe("formatRelative", () => {
  const now = Date.parse("2026-10-05T10:00:00.000Z");
  const at = (offsetMs: number) => new Date(now + offsetMs).toISOString();

  it("says just now for the last few seconds", () => {
    expect(formatRelative(at(-2_000), now)).toBe("just now");
  });
  it("counts seconds, minutes, hours and days in the past", () => {
    expect(formatRelative(at(-30_000), now)).toBe("30 seconds ago");
    expect(formatRelative(at(-5 * 60_000), now)).toBe("5 minutes ago");
    expect(formatRelative(at(-3 * 3_600_000), now)).toBe("3 hours ago");
    expect(formatRelative(at(-2 * 86_400_000), now)).toBe("2 days ago");
  });
  it("reads a future time as in...", () => {
    expect(formatRelative(at(2 * 60_000), now)).toBe("in 2 minutes");
  });
});

describe("shortSha", () => {
  it("keeps seven characters", () => {
    expect(shortSha("0123456789abcdef")).toBe("0123456");
  });
});
