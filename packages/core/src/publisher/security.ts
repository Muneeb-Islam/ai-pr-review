import type { Finding } from "@ai-pr-review/shared";
import type { AgentState } from "./labels";

// The overall security status (FR-28) shown in the summary and the Check Run, and the sentence that says what the
// Security agent is not (FR-29): an advisory review by a model and a few rules, not a scanner.

/**
 * A critical or high finding is called out at the top when the agent is at least this sure. The validator's own
 * `minimum_confidence` may be lower; the call-out stays strict so it is not raised for a guess.
 */
export const SECURITY_CALLOUT_CONFIDENCE = 0.8;

export const SECURITY_ADVISORY =
  "Security review is advisory: it is not a replacement for SAST or dependency scanning.";

export type SecurityLevel =
  /** At least one high-confidence critical or high finding. */
  | "attention"
  /** Findings, none of them critical or high with high confidence. */
  | "findings"
  /** The agent finished and found nothing. */
  | "clear"
  /** The agent failed or timed out: no finding is not good news. */
  | "incomplete"
  /** Enabled, but the pull request changes nothing the agent reads. */
  | "not_run"
  /** Switched off in the configuration. */
  | "off";

export interface SecurityStatus {
  level: SecurityLevel;
  /** The critical and high findings that are called out, most severe first. */
  callouts: Finding[];
  critical: number;
  high: number;
  /** Security findings of any severity. */
  total: number;
  /** One sentence for the summary and the Check Run. */
  text: string;
}

const plural = (n: number, word: string): string => `${n} ${word}${n === 1 ? "" : "s"}`;

/** `state` is the Security agent's state in the run (`agentStates`); `findings` are the run's accepted findings. */
export function securityStatus(findings: readonly Finding[], state: AgentState): SecurityStatus {
  const security = findings.filter((f) => f.category === "security");
  const callouts = security
    .filter(
      (f) =>
        (f.severity === "critical" || f.severity === "high") &&
        f.confidence >= SECURITY_CALLOUT_CONFIDENCE,
    )
    .sort(
      (a, b) =>
        (a.severity === b.severity ? 0 : a.severity === "critical" ? -1 : 1) ||
        b.confidence - a.confidence,
    );
  const critical = callouts.filter((f) => f.severity === "critical").length;
  const high = callouts.length - critical;
  const base = { callouts, critical, high, total: security.length };
  const finished = state === "ok";

  if (state === "off") return { ...base, level: "off", text: "The Security agent is off." };
  if (state === "not_run" || state === "not_available") {
    return {
      ...base,
      level: "not_run",
      text:
        state === "not_run"
          ? "The Security agent did not run for this pull request."
          : "The Security agent is not available.",
    };
  }
  if (callouts.length > 0) {
    const counts = [
      critical > 0 ? `${critical} critical` : "",
      high > 0 ? `${high} high` : "",
    ].filter(Boolean);
    return {
      ...base,
      level: "attention",
      text: `Attention needed: ${counts.join(", ")} security ${callouts.length === 1 ? "finding" : "findings"}.${
        finished ? "" : " The security review did not finish, so there may be more."
      }`,
    };
  }
  if (!finished) {
    return {
      ...base,
      level: "incomplete",
      text: `The security review did not complete${
        security.length > 0 ? `; it reported ${plural(security.length, "finding")} before that` : ""
      }. No finding does not mean the change is safe.`,
    };
  }
  if (security.length > 0) {
    return {
      ...base,
      level: "findings",
      text: `No high-confidence critical or high security findings. ${plural(security.length, "other security finding")} listed below.`,
    };
  }
  return { ...base, level: "clear", text: "No security findings reported." };
}
