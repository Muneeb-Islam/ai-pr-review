// Time buckets for the charts. The database returns only buckets that have runs; the chart wants every bucket of
// the range, with zeros, so a quiet week is a gap you can see rather than a line that skips it.
import type { AnalyticsTimeseriesDto } from "@ai-pr-review/shared";
import type { Bucket, TimeseriesPoint } from "@ai-pr-review/db";

const DAY_MS = 86_400_000;

/** A range of more than this many days is answered in weeks, whatever was asked. */
export const MAX_DAILY_RANGE_DAYS = 92;
/** The longest range the analytics endpoints answer. */
export const MAX_RANGE_DAYS = 366;

/** Start of the UTC day (or of the ISO week, a Monday) that contains `date`. */
export function bucketStart(date: Date, bucket: Bucket): Date {
  const day = Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate());
  if (bucket === "day") return new Date(day);
  const weekday = (new Date(day).getUTCDay() + 6) % 7; // Monday = 0
  return new Date(day - weekday * DAY_MS);
}

/** The bucket actually used: `day` only for ranges short enough to read as days. */
export function chooseBucket(from: Date, to: Date, asked: Bucket | undefined): Bucket {
  const days = (to.getTime() - from.getTime()) / DAY_MS;
  if (days > MAX_DAILY_RANGE_DAYS) return "week";
  return asked ?? "day";
}

export const isoSeconds = (date: Date): string => date.toISOString().replace(/\.\d{3}Z$/, "Z");

const zero = (start: string): AnalyticsTimeseriesDto["points"][number] => ({
  start,
  reviews: 0,
  completed: 0,
  partial: 0,
  failed: 0,
  findings: { critical: 0, high: 0, medium: 0, low: 0, info: 0 },
  median_duration_ms: null,
  input_tokens: 0,
  output_tokens: 0,
  causes: { timeout: 0, invalid_output: 0, agent_failed: 0, other: 0 },
});

/** One point per bucket from the bucket of `from` to the bucket of `to`, with zeros where nothing happened. */
export function fillBuckets(
  points: readonly TimeseriesPoint[],
  from: Date,
  to: Date,
  bucket: Bucket,
): AnalyticsTimeseriesDto["points"] {
  const byStart = new Map(points.map((p) => [p.start, p]));
  const step = bucket === "day" ? DAY_MS : 7 * DAY_MS;
  const out: AnalyticsTimeseriesDto["points"] = [];
  for (let at = bucketStart(from, bucket).getTime(); at <= to.getTime(); at += step) {
    const start = isoSeconds(new Date(at));
    out.push(byStart.get(start) ?? zero(start));
  }
  return out;
}
