import { describe, expect, it } from "vitest";
import { bucketStart, chooseBucket, fillBuckets } from "./buckets";

const d = (iso: string) => new Date(iso);

describe("bucketStart", () => {
  it("starts a day at 00:00 UTC", () => {
    expect(bucketStart(d("2026-10-02T23:59:59Z"), "day").toISOString()).toBe(
      "2026-10-02T00:00:00.000Z",
    );
  });

  it("starts a week on Monday", () => {
    // 2026-10-02 is a Friday.
    expect(bucketStart(d("2026-10-02T10:00:00Z"), "week").toISOString()).toBe(
      "2026-09-28T00:00:00.000Z",
    );
    expect(bucketStart(d("2026-09-28T00:00:00Z"), "week").toISOString()).toBe(
      "2026-09-28T00:00:00.000Z",
    );
    // A Sunday belongs to the week that began the Monday before.
    expect(bucketStart(d("2026-10-04T12:00:00Z"), "week").toISOString()).toBe(
      "2026-09-28T00:00:00.000Z",
    );
  });
});

describe("chooseBucket", () => {
  it("honours the request for a short range and defaults to days", () => {
    expect(chooseBucket(d("2026-09-01T00:00:00Z"), d("2026-10-01T00:00:00Z"), undefined)).toBe(
      "day",
    );
    expect(chooseBucket(d("2026-09-01T00:00:00Z"), d("2026-10-01T00:00:00Z"), "week")).toBe("week");
  });

  it("answers a range longer than 92 days in weeks whatever was asked", () => {
    expect(chooseBucket(d("2026-01-01T00:00:00Z"), d("2026-10-01T00:00:00Z"), "day")).toBe("week");
  });
});

describe("fillBuckets", () => {
  it("returns one point per bucket from the first to the last, with zeros for quiet ones", () => {
    const real = {
      start: "2026-10-01T00:00:00Z",
      reviews: 2,
      completed: 2,
      partial: 0,
      failed: 0,
      findings: { critical: 0, high: 1, medium: 0, low: 0, info: 0 },
      median_duration_ms: 1000,
      input_tokens: 5,
      output_tokens: 6,
      causes: { timeout: 0, invalid_output: 0, agent_failed: 0, other: 0 },
    };
    const points = fillBuckets([real], d("2026-09-30T08:00:00Z"), d("2026-10-02T09:00:00Z"), "day");
    expect(points.map((p) => p.start)).toEqual([
      "2026-09-30T00:00:00Z",
      "2026-10-01T00:00:00Z",
      "2026-10-02T00:00:00Z",
    ]);
    expect(points[1]).toBe(real);
    expect(points[0]).toMatchObject({ reviews: 0, median_duration_ms: null });
  });
});
