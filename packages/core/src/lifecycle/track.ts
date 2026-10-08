import type {
  AgentId,
  AgentRunStatus,
  Finding,
  FindingTracking,
  Severity,
  TrackedFinding,
  TrackedState,
} from "@ai-pr-review/shared";
import type { ReviewContext } from "../context/types";
import { AGENT_LABELS } from "../publisher/labels";
import { SEVERITY_RANK } from "../validation/severity";
import { matchFindings, type PreviousFinding } from "./match";

// What became of the previous review's findings (FR-37). A finding the new run does not report again is only
// "resolved" if the run really looked at that code; if it could not look (the file was left out, the agent that
// found it failed or was off) saying "resolved" would be a claim nobody checked, so it is "not evaluated".

export interface TrackInput {
  previous: { runId: string; headSha: string; findings: readonly PreviousFinding[] };
  /** The findings this run reported (after validation). */
  current: readonly Finding[];
  context: Pick<ReviewContext, "files" | "skippedFiles">;
  /** How each agent fared in this run; an agent without an entry did not run. */
  agents: ReadonlyArray<{ agent: AgentId; status: AgentRunStatus }>;
}

const STATE_ORDER: Record<TrackedState, number> = {
  resolved: 0,
  still_applicable: 1,
  not_evaluated: 2,
};

const REASONS = {
  deleted: "The file was deleted in this pull request.",
  unchanged: "The file is no longer changed by this pull request.",
  skipped: (why: string) => `The file was not reviewed this time: ${why}`,
  agent: (agent: AgentId, status: AgentRunStatus | undefined) =>
    status === undefined
      ? `The ${AGENT_LABELS[agent]} check did not run this time.`
      : `The ${AGENT_LABELS[agent]} check did not finish this time.`,
};

function tracked(
  state: TrackedState,
  item: Pick<
    PreviousFinding,
    "fingerprint" | "agent" | "category" | "severity" | "title" | "filePath" | "startLine"
  >,
  reason?: string,
): TrackedFinding {
  return {
    state,
    fingerprint: item.fingerprint,
    agent: item.agent,
    category: item.category,
    severity: item.severity,
    title: item.title,
    ...(item.filePath !== undefined ? { filePath: item.filePath } : {}),
    ...(item.startLine !== undefined ? { startLine: item.startLine } : {}),
    ...(reason !== undefined ? { reason } : {}),
  };
}

const bySeverity = (a: Severity, b: Severity): number => SEVERITY_RANK[b] - SEVERITY_RANK[a];

/**
 * Compares this run with the previous review. Returns undefined when that review had no findings (there is
 * nothing to compare with). The list is ordered resolved, still applicable, not evaluated, then by severity.
 */
export function trackFindings(input: TrackInput): FindingTracking | undefined {
  const { previous, context } = input;
  if (previous.findings.length === 0) return undefined;

  const { pairs, unmatched } = matchFindings(input.current, previous.findings);
  const items: TrackedFinding[] = [];

  for (const finding of input.current) {
    if (!pairs.has(finding)) continue;
    items.push(
      tracked("still_applicable", {
        fingerprint: finding.id,
        agent: finding.agent,
        category: finding.category,
        severity: finding.severity,
        title: finding.title,
        filePath: finding.filePath,
        startLine: finding.startLine,
      }),
    );
  }

  const agentStatus = new Map(input.agents.map((a) => [a.agent, a.status]));
  for (const before of unmatched) {
    if (before.filePath !== undefined) {
      const skipped = context.skippedFiles.find((f) => f.path === before.filePath);
      if (skipped) {
        items.push(tracked("not_evaluated", before, REASONS.skipped(skipped.reason)));
        continue;
      }
      const file = context.files.find((f) => f.path === before.filePath);
      if (!file) {
        items.push(tracked("resolved", before, REASONS.unchanged));
        continue;
      }
      if (file.status === "removed") {
        items.push(tracked("resolved", before, REASONS.deleted));
        continue;
      }
    }
    const status = agentStatus.get(before.agent);
    if (status !== "ok") {
      items.push(tracked("not_evaluated", before, REASONS.agent(before.agent, status)));
      continue;
    }
    items.push(tracked("resolved", before));
  }

  items.sort(
    (a, b) =>
      STATE_ORDER[a.state] - STATE_ORDER[b.state] ||
      bySeverity(a.severity, b.severity) ||
      (a.filePath ?? "").localeCompare(b.filePath ?? "") ||
      (a.startLine ?? 0) - (b.startLine ?? 0) ||
      a.fingerprint.localeCompare(b.fingerprint),
  );
  return { previousRunId: previous.runId, previousHeadSha: previous.headSha, items };
}

export function countTracked(items: readonly TrackedFinding[]): Record<TrackedState, number> {
  const counts: Record<TrackedState, number> = {
    resolved: 0,
    still_applicable: 0,
    not_evaluated: 0,
  };
  for (const item of items) counts[item.state] += 1;
  return counts;
}
