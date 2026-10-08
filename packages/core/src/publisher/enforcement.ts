import type { Finding, ResolvedConfig, RunStatus, Severity } from "@ai-pr-review/shared";
import { meetsSeverity } from "../validation/severity";

// Enforcement (FR-34, AC-12, design §14). The mode decides what the Check Run's conclusion says about the findings:
//
//   comment_only        never fails the check because of a finding (the default)
//   warn                a finding at the thresholds makes the check `neutral` instead of `success`
//   fail_on_threshold   a finding at the thresholds makes the check `failure`
//
// "At the thresholds" means BOTH `review.minimum_severity` and `review.minimum_confidence`: a high-severity guess
// and a confident nitpick are not what a team means by "block this merge". The validator already drops findings
// below the thresholds before they are accepted, so for the findings the publisher sees the test is normally
// true; it is checked again here so the conclusion never depends on that happening upstream.
//
// A `failure` stops a merge only if the repository lists the check as required (branch protection or a ruleset).
// The Check Run says so when it fails.

export type EnforcementMode = ResolvedConfig["review"]["mode"];

export interface EnforcementPolicy {
  mode: EnforcementMode;
  minimumSeverity: Severity;
  minimumConfidence: number;
}

export const enforcementPolicy = (review: ResolvedConfig["review"]): EnforcementPolicy => ({
  mode: review.mode,
  minimumSeverity: review.minimum_severity,
  minimumConfidence: review.minimum_confidence,
});

/**
 * A finding that counts towards enforcement. Test suggestions never do: they are advice from reading the diff, and
 * a missing test must not be what stops a merge (decision 63).
 */
export function meetsEnforcementThreshold(finding: Finding, policy: EnforcementPolicy): boolean {
  return (
    finding.category !== "test_gap" &&
    meetsSeverity(finding.severity, policy.minimumSeverity) &&
    finding.confidence >= policy.minimumConfidence
  );
}

export const thresholdFindings = (
  findings: readonly Finding[],
  policy: EnforcementPolicy,
): Finding[] => findings.filter((f) => meetsEnforcementThreshold(f, policy));

/** The review produced findings this run can stand behind: it finished, or finished what it could. */
export const isReviewed = (status: RunStatus): boolean =>
  status === "completed" || status === "partial";

const plural = (n: number, word: string): string => `${n} ${word}${n === 1 ? "" : "s"}`;

const describeThreshold = (policy: EnforcementPolicy): string =>
  `${policy.minimumSeverity} severity or higher, at least ${Math.round(policy.minimumConfidence * 100)}% confidence`;

/**
 * One sentence about what the mode did to the check, or undefined when it has nothing to say (`comment_only`, or
 * a run that did not review anything).
 */
export function describeEnforcement(input: {
  policy: EnforcementPolicy;
  status: RunStatus;
  findings: readonly Finding[];
}): string | undefined {
  const { policy } = input;
  if (policy.mode === "comment_only" || !isReviewed(input.status)) return undefined;
  const blocking = thresholdFindings(input.findings, policy);
  const threshold = describeThreshold(policy);
  const label = `**Enforcement (\`${policy.mode}\`):**`;
  if (blocking.length === 0) return `${label} no finding meets the threshold (${threshold}).`;
  const meets = `${plural(blocking.length, "finding")} ${blocking.length === 1 ? "meets" : "meet"} the threshold (${threshold})`;
  return policy.mode === "fail_on_threshold"
    ? `${label} ${meets}, so this check fails. A failing check blocks merging only if the repository requires it.`
    : `${label} ${meets}, so this check is neutral.`;
}
