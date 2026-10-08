import type { Severity } from "@ai-pr-review/shared";

/** Higher is more severe. */
export const SEVERITY_RANK: Readonly<Record<Severity, number>> = {
  critical: 4,
  high: 3,
  medium: 2,
  low: 1,
  info: 0,
};

export const meetsSeverity = (severity: Severity, minimum: Severity): boolean =>
  SEVERITY_RANK[severity] >= SEVERITY_RANK[minimum];
