import type { RunDetail } from "../hooks/queries";

// The overall security status of a run (FR-28), worked out from what the api returns. It mirrors the summary's
// "Security" block in `packages/core/src/publisher/security.ts`: the web app imports only the api contract, so the
// few rules are repeated here. Keep the two in step.

type Finding = RunDetail["findings"][number];

/** A critical or high finding is called out when the agent is at least this sure. */
export const SECURITY_CALLOUT_CONFIDENCE = 0.8;

export const SECURITY_ADVISORY =
  "Security review is advisory: it is not a replacement for SAST or dependency scanning.";

export type SecurityLevel = "attention" | "findings" | "clear" | "incomplete";

export interface SecurityOverview {
  level: SecurityLevel;
  text: string;
  /** High-confidence critical and high findings, most severe first. */
  callouts: Finding[];
  total: number;
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

/** `undefined` when the Security agent took no part in the run (off, skipped, or an older run). */
export function securityOverview(run: RunDetail): SecurityOverview | undefined {
  const agent = run.agent_runs.find((a) => a.agent === "security");
  const security = run.findings.filter((f) => f.category === "security");
  if (!agent && security.length === 0) return undefined;

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
  const finished = agent?.status === "ok";
  const base = { callouts, total: security.length };

  if (callouts.length > 0) {
    const counts = [critical > 0 ? `${critical} critical` : "", high > 0 ? `${high} high` : ""]
      .filter(Boolean)
      .join(", ");
    return {
      ...base,
      level: "attention",
      text: `Attention needed: ${counts} security ${callouts.length === 1 ? "finding" : "findings"}.${
        finished || !agent ? "" : " The security review did not finish, so there may be more."
      }`,
    };
  }
  if (agent && !finished) {
    return {
      ...base,
      level: "incomplete",
      text: "The security review did not complete. No finding does not mean the change is safe.",
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
