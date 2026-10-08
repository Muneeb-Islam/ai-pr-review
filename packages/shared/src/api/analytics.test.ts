import { describe, expect, it } from "vitest";
import { ANALYTICS_TARGETS, judgeMetric, MIN_SAMPLE_SIZE } from "./analytics";

describe("judgeMetric (PRD section 13)", () => {
  it("has no verdict without data", () => {
    expect(judgeMetric("completion_rate", null, 0)).toEqual({
      state: "no_data",
      small_sample: true,
    });
    expect(judgeMetric("completion_rate", 1, 0).state).toBe("no_data");
  });

  it("meets an 'at least' target exactly at the goal", () => {
    expect(judgeMetric("completion_rate", 0.95, 100).state).toBe("met");
    expect(judgeMetric("completion_rate", 0.949, 100).state).toBe("missed");
    expect(judgeMetric("actionable_rate", 0.7, 100).state).toBe("met");
    expect(judgeMetric("summary_coverage", 0.89, 100).state).toBe("missed");
  });

  it("meets an 'under' target only strictly below the goal", () => {
    expect(judgeMetric("false_positive_rate", 0.19, 100).state).toBe("met");
    expect(judgeMetric("false_positive_rate", 0.2, 100).state).toBe("missed");
    expect(judgeMetric("duplicate_rate", 0.019, 100).state).toBe("met");
    expect(judgeMetric("duplicate_rate", 0.02, 100).state).toBe("missed");
    expect(judgeMetric("median_duration_ms", 299_999, 50).state).toBe("met");
    expect(judgeMetric("median_duration_ms", 300_000, 50).state).toBe("missed");
  });

  it("flags a small sample but still judges", () => {
    expect(judgeMetric("actionable_rate", 0.75, MIN_SAMPLE_SIZE - 1)).toEqual({
      state: "met",
      small_sample: true,
    });
    expect(judgeMetric("actionable_rate", 0.75, MIN_SAMPLE_SIZE)).toEqual({
      state: "met",
      small_sample: false,
    });
  });

  it("states every target the way the PRD does", () => {
    expect(Object.values(ANALYTICS_TARGETS).map((t) => t.label)).toEqual([
      "At least 95%",
      "Under 5 minutes",
      "At least 70%",
      "Under 20%",
      "Under 2%",
      "At least 90%",
    ]);
  });
});
