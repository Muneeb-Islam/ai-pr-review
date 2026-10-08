import type { CoverageSummary, Finding, RunStatus } from "@ai-pr-review/shared";
import { SEVERITY_LABELS, SEVERITY_ORDER, shortSha, type AgentState } from "./labels";
import {
  describeEnforcement,
  isReviewed,
  thresholdFindings,
  type EnforcementPolicy,
} from "./enforcement";
import { securityScrub } from "../security/sanitize";
import { SECURITY_ADVISORY, securityStatus } from "./security";
import { countBySeverity, describeCounts } from "./summary";
import { codeSpan, finalizeBody, sanitizeLine } from "./text";

// The `AI PR Review` Check Run (FR-30): queued when the run is created (Phase 3), in progress while the worker
// reviews, completed with a conclusion, a title and a short summary at the end.

export type CheckConclusion = "success" | "neutral" | "failure";

const MAX_TITLE_CHARS = 120;
const MAX_CHECK_CHARS = 20_000;
const MAX_LISTED = 10;

export interface CheckOutcome {
  /** The run's final status. */
  status: RunStatus;
  reason?: string | undefined;
  /** Accepted findings (empty when the run did not review anything). */
  findings: readonly Finding[];
  warnings: readonly string[];
  /** What the Test Coverage agent measured, when it ran. */
  coverage?: CoverageSummary | undefined;
  /** The Security agent's state in the run; without it the Check Run says nothing about security. */
  securityState?: AgentState | undefined;
  /** Some of what the review wanted to post could not be posted (a 403 or 422 from GitHub). */
  degraded: boolean;
  /** The repository's enforcement mode and thresholds. Without it the check behaves as `comment_only`. */
  policy?: EnforcementPolicy | undefined;
  headSha: string;
  dashboardUrl?: string | undefined;
}

/**
 * The Check Run's conclusion (design §14, FR-34, AC-12):
 *
 * - `failure` only in `fail_on_threshold`, and only when a finding meets both thresholds. A partial review that
 *   found such a finding fails too: the finding stands whatever else went wrong.
 * - `success` only for a completed review that was fully posted and, in `warn` mode, has no finding at the
 *   thresholds.
 * - `neutral` for everything else: partial, skipped, failed, superseded, cancelled, comments that could not be
 *   posted, or a `warn` finding. A run that did not finish never fails the check, so an outage or a bad key
 *   cannot block a merge.
 */
export function checkConclusion(
  outcome: Pick<CheckOutcome, "status" | "degraded"> &
    Partial<Pick<CheckOutcome, "findings" | "policy">>,
): CheckConclusion {
  const { policy } = outcome;
  const atThreshold =
    policy && isReviewed(outcome.status) ? thresholdFindings(outcome.findings ?? [], policy) : [];
  if (policy?.mode === "fail_on_threshold" && atThreshold.length > 0) return "failure";
  if (outcome.status !== "completed" || outcome.degraded) return "neutral";
  if (policy?.mode === "warn" && atThreshold.length > 0) return "neutral";
  return "success";
}

const plural = (n: number, word: string): string => `${n} ${word}${n === 1 ? "" : "s"}`;

export function checkTitle(outcome: CheckOutcome): string {
  const counts = countBySeverity(outcome.findings);
  const found =
    outcome.findings.length === 0
      ? undefined
      : `${plural(outcome.findings.length, "finding")}: ${describeCounts(counts)}`;
  let title: string;
  switch (outcome.status) {
    case "completed":
      title = found ?? "No issues found";
      break;
    case "partial":
      title = found ? `Partial review, ${found}` : "Partial review";
      break;
    case "skipped":
      title = "Review skipped";
      break;
    case "failed":
      title = "Review failed";
      break;
    case "superseded":
      title = "Superseded by a newer commit";
      break;
    case "cancelled":
      title = "Review cancelled";
      break;
    default:
      title = "Review in progress";
  }
  const security = outcome.securityState
    ? securityStatus(outcome.findings, outcome.securityState)
    : undefined;
  if (security?.level === "attention") title += " (security attention needed)";
  if (checkConclusion(outcome) === "failure") title += " (fails the check)";
  if (outcome.degraded) title += " (some comments could not be posted)";
  return sanitizeLine(title, MAX_TITLE_CHARS);
}

/** One line for the Check Run: the measured share, or that nothing was measured and why. */
function describeCoverage(coverage: CoverageSummary | undefined): string | undefined {
  if (!coverage || coverage.status === "skipped") return undefined;
  if (coverage.status === "not_available") {
    return `**Coverage:** not measured. ${sanitizeLine(coverage.reason ?? "No report was available.", 300)}`;
  }
  return coverage.changedLineCoverage === undefined
    ? "**Coverage:** measured; no executable changed lines."
    : `**Coverage:** ${Math.round(coverage.changedLineCoverage * 100)}% of changed lines (measured from the CI report).`;
}

/** The Check Run's `output`: a title and a short markdown summary (the full review is the PR comment). */
export function renderCheckOutput(outcome: CheckOutcome): { title: string; summary: string } {
  const counts = countBySeverity(outcome.findings);
  const parts: string[] = [`**Commit** ${codeSpan(shortSha(outcome.headSha))}`];
  if (outcome.reason && outcome.status !== "completed") {
    parts.push(sanitizeLine(outcome.reason, 500));
  }
  if (outcome.findings.length > 0) {
    parts.push(
      "| Critical | High | Medium | Low | Info |\n|:-:|:-:|:-:|:-:|:-:|\n" +
        `| ${SEVERITY_ORDER.map((s) => counts[s]).join(" | ")} |`,
    );
    const listed = outcome.findings.slice(0, MAX_LISTED).map((f) => {
      const where = f.filePath
        ? ` ${codeSpan(f.startLine === undefined ? f.filePath : `${f.filePath}:${f.startLine}`)}`
        : "";
      return `- ${SEVERITY_LABELS[f.severity]}: ${sanitizeLine(f.title, 160, f.category === "security" && securityScrub(f))}${where}`;
    });
    if (outcome.findings.length > MAX_LISTED) {
      listed.push(`- …and ${outcome.findings.length - MAX_LISTED} more.`);
    }
    parts.push(listed.join("\n"));
  } else if (outcome.status === "completed") {
    parts.push("The review found nothing to report.");
  }
  if (outcome.securityState && outcome.securityState !== "off") {
    const security = securityStatus(outcome.findings, outcome.securityState);
    parts.push(`**Security:** ${security.text} _${SECURITY_ADVISORY}_`);
  }
  const enforcement = outcome.policy
    ? describeEnforcement({
        policy: outcome.policy,
        status: outcome.status,
        findings: outcome.findings,
      })
    : undefined;
  if (enforcement) parts.push(enforcement);
  const coverageLine = describeCoverage(outcome.coverage);
  if (coverageLine) parts.push(coverageLine);
  if (outcome.warnings.length > 0) {
    const lines = outcome.warnings.slice(0, 10).map((w) => `- ${sanitizeLine(w, 300)}`);
    parts.push(["**Warnings**", ...lines].join("\n"));
  }
  if (outcome.dashboardUrl) parts.push(`[View this run in the dashboard](${outcome.dashboardUrl})`);
  return {
    title: checkTitle(outcome),
    summary: finalizeBody(parts.join("\n\n"), MAX_CHECK_CHARS),
  };
}
