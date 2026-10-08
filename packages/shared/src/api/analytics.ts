// The success metrics of the PRD (§13) and how each is judged. The api returns raw numbers; the dashboard (and
// tests) judge them here, so "met" means the same thing everywhere. Small samples are flagged rather than hidden:
// 3 of 4 findings rated useful is 75% and means almost nothing.

export const ANALYTICS_METRICS = [
  "completion_rate",
  "median_duration_ms",
  "actionable_rate",
  "false_positive_rate",
  "duplicate_rate",
  "summary_coverage",
] as const;
export type AnalyticsMetric = (typeof ANALYTICS_METRICS)[number];

export interface MetricTarget {
  /** The PRD §13 wording of the target, for display. */
  label: string;
  goal: number;
  /** `min`: the value must reach the goal ("at least"). `max`: it must stay below it ("under"). */
  kind: "min" | "max";
}

export const ANALYTICS_TARGETS: Record<AnalyticsMetric, MetricTarget> = {
  completion_rate: { label: "At least 95%", goal: 0.95, kind: "min" },
  median_duration_ms: { label: "Under 5 minutes", goal: 5 * 60_000, kind: "max" },
  actionable_rate: { label: "At least 70%", goal: 0.7, kind: "min" },
  false_positive_rate: { label: "Under 20%", goal: 0.2, kind: "max" },
  duplicate_rate: { label: "Under 2%", goal: 0.02, kind: "max" },
  summary_coverage: { label: "At least 90%", goal: 0.9, kind: "min" },
};

/** Fewer observations than this and a rate is shown as "not enough data" for judging, though still displayed. */
export const MIN_SAMPLE_SIZE = 10;

export type TargetState = "met" | "missed" | "no_data";

export interface TargetVerdict {
  state: TargetState;
  /** The sample is too small to read much into the verdict. */
  small_sample: boolean;
}

/** `value` is null when there was nothing to measure; `sample` is how many observations it rests on. */
export function judgeMetric(
  metric: AnalyticsMetric,
  value: number | null,
  sample: number,
): TargetVerdict {
  if (value === null || sample === 0) return { state: "no_data", small_sample: true };
  const { goal, kind } = ANALYTICS_TARGETS[metric];
  const met = kind === "min" ? value >= goal : value < goal;
  return { state: met ? "met" : "missed", small_sample: sample < MIN_SAMPLE_SIZE };
}
