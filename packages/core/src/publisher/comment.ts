import type { Finding } from "@ai-pr-review/shared";
import { fingerprintMarker } from "../context/markers";
import { AGENT_LABELS, CATEGORY_LABELS, SEVERITY_LABELS } from "./labels";
import { securityScrub, type SecurityScrub } from "../security/sanitize";
import { finalizeBody, sanitizeLine, sanitizeText } from "./text";

/** Room for the longest comment we write; GitHub's limit is 65 536. */
const MAX_COMMENT_CHARS = 3_000;
const MAX_EVIDENCE_LINES = 3;
/** A security finding quotes one line at most: enough to find the code, not a sensitive fragment (FR-29). */
const MAX_SECURITY_EVIDENCE_LINES = 1;
const MAX_EVIDENCE_LINE_CHARS = 140;

/** A short quote of the code the finding is about: at most three short lines, never a whole excerpt. */
function evidenceBlock(evidence: string, security: boolean | SecurityScrub): string | undefined {
  const lines = sanitizeText(evidence, { maxChars: 600, security })
    .split("\n")
    .map((l) => l.trimEnd())
    .filter((l) => l.trim() !== "" && !l.startsWith("```"))
    .slice(0, security === false ? MAX_EVIDENCE_LINES : MAX_SECURITY_EVIDENCE_LINES)
    .map((l) =>
      l.length > MAX_EVIDENCE_LINE_CHARS ? `${l.slice(0, MAX_EVIDENCE_LINE_CHARS)}…` : l,
    );
  if (lines.length === 0) return undefined;
  return ["```text", ...lines.map((l) => l.replaceAll("```", "'''")), "```"].join("\n");
}

/**
 * The body of one inline review comment (FR-17, FR-21). The hidden fingerprint marker comes first, so a marker
 * inside model text can never be the one that is read (`sanitizeText` also breaks such text).
 */
export function renderInlineComment(
  finding: Finding,
  options: { headSha: string; dashboardUrl?: string | undefined },
): string {
  const isTestGap = finding.category === "test_gap";
  const security = finding.category === "security" && securityScrub(finding);
  const parts: string[] = [
    fingerprintMarker(finding.id, options.headSha),
    // A test gap found by reading the diff is a suggestion, never a measurement (FR-25, AC-5).
    isTestGap
      ? `**Suggested missing test** — ${sanitizeLine(finding.title.replace(/^missing test:\s*/i, ""), 160)}`
      : `**${SEVERITY_LABELS[finding.severity]} · ${CATEGORY_LABELS[finding.category]}** — ${sanitizeLine(finding.title, 160, security)}`,
    sanitizeText(finding.impact, { maxChars: 700, security }),
    `**${finding.category === "security" ? "Mitigation" : "Suggestion"}:** ${sanitizeText(finding.recommendation, { maxChars: 700, security })}`,
  ];
  const evidence = evidenceBlock(finding.evidence, security);
  if (evidence) parts.push(evidence);
  if (isTestGap && finding.suggestedTest) {
    parts.push(
      `**Test to add:** ${sanitizeText(finding.suggestedTest, { maxChars: 700 }).replace(/\n+/g, " ")}`,
    );
  }

  const footer = [
    AGENT_LABELS[finding.agent],
    ...(isTestGap ? ["suggestion from reading the diff, not measured coverage"] : []),
    ...(finding.category === "security"
      ? ["advisory, not a replacement for SAST or dependency scanning"]
      : []),
    `confidence ${Math.round(finding.confidence * 100)}%`,
    ...(options.dashboardUrl ? [`[run details](${options.dashboardUrl})`] : []),
  ].join(" · ");
  parts.push(`<sub>${footer}</sub>`);
  return finalizeBody(parts.join("\n\n"), MAX_COMMENT_CHARS);
}
