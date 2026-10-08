import type {
  AgentId,
  AgentRunStatus,
  CoverageFile,
  FinalReviewSummary,
  Finding,
  FindingTracking,
  ResolvedConfig,
  ReviewStatus,
  Severity,
  SuppressReason,
} from "@ai-pr-review/shared";
import type { AgentCoverage } from "../agents/types";
import { SUMMARY_MARKER_TEXT } from "../context/markers";
import type { SkippedFile } from "../context/types";
import { countTracked } from "../lifecycle/track";
import {
  AGENT_LABELS,
  SEVERITY_LABELS,
  SEVERITY_ORDER,
  SUPPRESS_LABELS,
  shortSha,
  type AgentState,
} from "./labels";
import { securityScrub } from "../security/sanitize";
import { SECURITY_ADVISORY, securityStatus } from "./security";
import { codeSpan, finalizeBody, sanitizeLine, sanitizeText } from "./text";

// The one maintained summary comment (FR-20, FR-21, FR-31, FR-32). Short sections, `<details>` for long lists,
// plain markdown only (no colours or custom HTML), so it reads in dark mode and on a phone.

/** GitHub allows 65 536; stay well below it. */
const MAX_SUMMARY_CHARS = 60_000;
/** A severity group longer than this, and the quieter severities, are folded away. */
const OPEN_GROUP_LIMIT = 5;
const MAX_LISTED_FILES = 50;
const MAX_NOTES = 10;

export type { AgentState } from "./labels";

export interface SummaryFinding {
  finding: Finding;
  /** Posted as an inline review comment (now or earlier for this head SHA). */
  inline: boolean;
}

export interface SummaryInput {
  status: ReviewStatus;
  headSha: string;
  /** Why the review was skipped or failed. */
  reason?: string | undefined;
  /** Why the review is limited (size policy), when it still ran. */
  limitReason?: string | undefined;
  findings: readonly SummaryFinding[];
  suppressedCounts: Partial<Record<SuppressReason, number>>;
  observations: ReadonlyArray<{ agent: AgentId; text: string }>;
  /** The review agents and what became of each. */
  agents: ReadonlyArray<{ agent: AgentId; state: AgentState }>;
  coverage?: AgentCoverage | undefined;
  skippedFiles: readonly SkippedFile[];
  warnings: readonly string[];
  isDraft: boolean;
  /** Findings the review kept out of the inline comments only because of `max_inline_comments`. */
  inlineCapped: number;
  dashboardUrl?: string | undefined;
  /** What became of the previous review's findings (FR-37); absent when there was nothing to compare with. */
  tracking?: FindingTracking | undefined;
  /** What the enforcement mode did to the check (`describeEnforcement`); absent in `comment_only`. */
  enforcement?: string | undefined;
  /** What the Final Review pass did; absent when it did not run. */
  finalReview?: FinalReviewSummary | undefined;
}

const STATUS_LABELS: Record<ReviewStatus, string> = {
  completed: "Completed",
  partial: "Partial",
  skipped: "Skipped",
  failed: "Failed",
};

const STATE_LABELS: Record<AgentState, string> = {
  ok: "Done",
  failed: "Failed",
  timeout: "Timed out",
  invalid_output: "Output discarded",
  off: "Off",
  not_run: "Not run",
  not_available: "Not available yet",
};

/** Agents the platform ships; one that is enabled but has no run reads "not run", any other "not available yet". */
const IMPLEMENTED_AGENTS: ReadonlySet<AgentId> = new Set([
  "code_review",
  "test_coverage",
  "security",
  "final_review",
]);

/** The review agents shown in the "Checks" table, with their state for this run. */
export function agentStates(
  config: ResolvedConfig,
  agentRuns: ReadonlyArray<{ agent: AgentId; status: AgentRunStatus }>,
): SummaryInput["agents"] {
  // Final Review is optional and off by default: it has a row only when it is switched on.
  const shown: AgentId[] = [
    "code_review",
    "test_coverage",
    "security",
    ...(config.agents.final_review ? (["final_review"] as const) : []),
  ];
  return shown.map((agent) => {
    if (!config.agents[agent]) return { agent, state: "off" as const };
    const run = agentRuns.find((r) => r.agent === agent);
    if (run) return { agent, state: run.status };
    return {
      agent,
      state: IMPLEMENTED_AGENTS.has(agent) ? ("not_run" as const) : ("not_available" as const),
    };
  });
}

export function countBySeverity(
  findings: readonly { severity: Severity }[],
): Record<Severity, number> {
  const counts: Record<Severity, number> = { critical: 0, high: 0, medium: 0, low: 0, info: 0 };
  for (const f of findings) counts[f.severity] += 1;
  return counts;
}

/** "1 high, 2 medium" (most severe first; zero counts left out). */
export function describeCounts(counts: Record<Severity, number>): string {
  return SEVERITY_ORDER.filter((s) => counts[s] > 0)
    .map((s) => `${counts[s]} ${s}`)
    .join(", ");
}

const plural = (n: number, word: string): string => `${n} ${word}${n === 1 ? "" : "s"}`;

function headline(input: SummaryInput, total: number, counts: Record<Severity, number>): string {
  if (input.status === "skipped") {
    return `Not reviewed: ${sanitizeLine(input.reason ?? "the pull request was skipped.", 300)}`;
  }
  if (input.status === "failed") {
    return `The review failed: ${sanitizeLine(input.reason ?? "no agent could finish.", 300)}`;
  }
  if (total === 0) return "No findings.";
  return `${plural(total, "finding")}: ${describeCounts(counts)}.`;
}

function findingItem(item: SummaryFinding, detail: boolean): string {
  const { finding } = item;
  // Text of a security finding also loses generic credentials and exploit payloads (FR-29).
  const security = finding.category === "security" && securityScrub(finding);
  const where =
    finding.filePath === undefined
      ? undefined
      : codeSpan(
          finding.startLine === undefined
            ? finding.filePath
            : `${finding.filePath}:${finding.startLine}${
                finding.endLine !== undefined && finding.endLine > finding.startLine
                  ? `-${finding.endLine}`
                  : ""
              }`,
        );
  const head = [
    `**${sanitizeLine(finding.title, 160, security)}**`,
    ...(where ? [where] : []),
    `_${AGENT_LABELS[finding.agent]}_`,
    ...(item.inline ? ["inline comment"] : []),
  ].join(" · ");
  if (!detail) return `- ${head}`;
  return [
    `- ${head}`,
    `  - ${sanitizeText(finding.impact, { maxChars: 400, security }).replace(/\n+/g, " ")}`,
    `  - ${finding.category === "security" ? "Mitigation" : "Suggestion"}: ${sanitizeText(finding.recommendation, { maxChars: 400, security }).replace(/\n+/g, " ")}`,
  ].join("\n");
}

const details = (summary: string, body: string): string =>
  `<details>\n<summary>${summary}</summary>\n\n${body}\n\n</details>`;

interface Level {
  /** Show impact and suggestion under each finding. */
  detail: boolean;
  /** Findings listed in total. */
  maxFindings: number;
}
const LEVELS: readonly Level[] = [
  { detail: true, maxFindings: Number.POSITIVE_INFINITY },
  { detail: false, maxFindings: Number.POSITIVE_INFINITY },
  { detail: false, maxFindings: 40 },
];

function findingsSection(
  findings: readonly SummaryFinding[],
  level: Level,
  calledOut: ReadonlySet<string>,
): string[] {
  // Test suggestions have their own section, and the security call-outs are listed under "Security".
  const listed = findings.filter(
    (f) => f.finding.category !== "test_gap" && !calledOut.has(f.finding.id),
  );
  if (listed.length === 0) return [];
  const out: string[] = ["### Findings"];
  let budget = level.maxFindings;
  for (const severity of SEVERITY_ORDER) {
    const group = listed.filter((f) => f.finding.severity === severity);
    if (group.length === 0) continue;
    const shown = group.slice(0, Math.max(0, budget));
    budget -= shown.length;
    if (shown.length === 0) continue;
    const lines = shown.map((f) => findingItem(f, level.detail));
    if (shown.length < group.length) {
      lines.push(`- …and ${group.length - shown.length} more (see the run in the dashboard).`);
    }
    const title = `${SEVERITY_LABELS[severity]} (${group.length})`;
    const folded = group.length > OPEN_GROUP_LIMIT || severity === "low" || severity === "info";
    out.push(folded ? details(title, lines.join("\n")) : `#### ${title}\n${lines.join("\n")}`);
  }
  return out;
}

/** The label that keeps an analysis-based gap from reading as a measurement (FR-25, AC-5). */
export const SUGGESTED_TEST_LABEL = "Suggested missing test";

const stripPrefix = (title: string): string => title.replace(/^missing test:\s*/i, "");

function testSection(findings: readonly SummaryFinding[], level: Level): string[] {
  const tests = findings.filter((f) => f.finding.category === "test_gap");
  if (tests.length === 0) return [];
  const lines = tests.slice(0, level.maxFindings).map(({ finding, inline }) => {
    const where =
      finding.filePath === undefined
        ? ""
        : ` ${codeSpan(finding.startLine === undefined ? finding.filePath : `${finding.filePath}:${finding.startLine}`)}`;
    const head = `- **${SUGGESTED_TEST_LABEL}**${where}: ${sanitizeLine(stripPrefix(finding.title), 160)}${inline ? " · _inline comment_" : ""}`;
    if (!level.detail || !finding.suggestedTest) return head;
    return `${head}\n  - ${sanitizeText(finding.suggestedTest, { maxChars: 500 }).replace(/\n+/g, " ")}`;
  });
  return [
    "### Suggested tests",
    "_These are suggestions from reading the diff and the existing tests. They are not measured coverage._",
    lines.join("\n"),
  ];
}

/**
 * The overall security status (FR-28): what the Security agent concluded, the high-confidence critical and high
 * findings in full, and the reminder that this is an advisory review (FR-29). Other security findings are listed
 * with the rest under "Findings". Nothing here quotes more than a finding's own sanitised text.
 */
function securitySection(input: SummaryInput, level: Level): string[] {
  const state = securityStateOf(input);
  if (state === "off") return [];
  const status = securityStatus(
    input.findings.map((f) => f.finding),
    state,
  );
  const out = ["### Security", status.level === "attention" ? `**${status.text}**` : status.text];
  if (status.callouts.length > 0) {
    const byId = new Map(input.findings.map((f) => [f.finding.id, f]));
    out.push(
      status.callouts
        .flatMap((f) => byId.get(f.id) ?? [])
        .slice(0, level.maxFindings)
        .map((item) => findingItem(item, level.detail))
        .join("\n"),
    );
  }
  out.push(`_${SECURITY_ADVISORY}_`);
  return out;
}

const securityStateOf = (input: SummaryInput): AgentState =>
  input.agents.find((a) => a.agent === "security")?.state ?? "off";

const percent = (share: number): string => `${Math.round(share * 100)}%`;

const rangesText = (file: CoverageFile): string => {
  const shown = file.uncovered
    .slice(0, 6)
    .map((r) => (r.start === r.end ? `${r.start}` : `${r.start}-${r.end}`))
    .join(", ");
  return file.uncovered.length > 6 ? `${shown}, …` : shown;
};

const MAX_COVERAGE_ROWS = 12;

/**
 * The measured part (FR-22, FR-23, FR-25): the share of changed lines that ran, from the LCOV report CI uploaded,
 * with the files that fall short labelled "Verified coverage deficiency". When there is no report it says so and
 * why. Nothing in this block comes from the model.
 */
function coverageSection(coverage: AgentCoverage | undefined): string[] {
  if (!coverage) return [];
  if (coverage.status !== "measured") {
    const why = coverage.reason ? ` ${sanitizeLine(coverage.reason, 300)}` : "";
    if (coverage.status === "skipped") return ["### Coverage", `Not measured.${why}`];
    return [
      "### Coverage",
      `**Coverage could not be measured.**${why} Test suggestions below come from reading the diff, not from a coverage report.`,
    ];
  }

  const files = coverage.files ?? [];
  const measured = files.filter((f) => f.status === "measured");
  const missing = files.filter((f) => f.status === "not_in_report");
  const total = coverage.totalLines ?? 0;
  const covered = coverage.coveredLines ?? 0;
  const headline =
    coverage.changedLineCoverage !== undefined
      ? `**Measured: ${percent(coverage.changedLineCoverage)} of changed lines covered** (${covered} of ${total} executable lines), from the CI coverage report.`
      : "**Measured:** the report has no executable changed lines to count.";

  const deficient = measured.filter((f) => f.totalLines > 0 && f.coveredLines < f.totalLines);
  const out = ["### Coverage", headline];
  if (deficient.length > 0) {
    const rows = deficient.slice(0, MAX_COVERAGE_ROWS).map((f) => {
      const functions = f.uncoveredFunctions?.length
        ? `; never called: ${f.uncoveredFunctions.map((n) => codeSpan(n)).join(", ")}`
        : "";
      return `- **Verified coverage deficiency** ${codeSpan(f.path)}: ${percent(f.coveredLines / f.totalLines)} (${f.coveredLines} of ${f.totalLines}); lines not run: ${rangesText(f)}${functions}`;
    });
    if (deficient.length > MAX_COVERAGE_ROWS) {
      rows.push(
        `- …and ${deficient.length - MAX_COVERAGE_ROWS} more files (see the run in the dashboard).`,
      );
    }
    out.push(rows.join("\n"));
  } else if (total > 0) {
    out.push("Every executable changed line in the report ran.");
  }
  if (missing.length > 0) {
    const names = missing.slice(0, 8).map((f) => codeSpan(f.path));
    out.push(
      `Not in the report, so their coverage is unknown (not zero): ${names.join(", ")}${missing.length > 8 ? `, and ${missing.length - 8} more` : ""}.`,
    );
  }
  return out;
}

function finalReviewLine(review: FinalReviewSummary | undefined): string[] {
  if (!review || review.reviewed === 0) return [];
  if (review.status !== "ok") {
    return [
      "_Final Review did not finish, so these findings were not double-checked and are listed as found._",
    ];
  }
  const rejected =
    review.rejected === 0
      ? "kept all of them"
      : `rejected ${review.rejected} as not supported by the diff`;
  return [`_Final Review checked ${plural(review.reviewed, "finding")} and ${rejected}._`];
}

function checksSection(input: SummaryInput): string[] {
  const rows = input.agents.map((a) => `| ${AGENT_LABELS[a.agent]} | ${STATE_LABELS[a.state]} |`);
  return [
    "### Checks",
    "| Check | Status |\n|---|---|\n" + rows.join("\n"),
    ...finalReviewLine(input.finalReview),
  ];
}

const MAX_TRACKED_LISTED = 15;

function trackedItem(item: FindingTracking["items"][number]): string {
  const title = sanitizeLine(item.title, 160, item.category === "security");
  const where = item.filePath
    ? ` ${codeSpan(item.startLine === undefined ? item.filePath : `${item.filePath}:${item.startLine}`)}`
    : "";
  const why = item.reason ? ` · ${sanitizeLine(item.reason, 200)}` : "";
  const text = item.state === "resolved" ? `~~${title}~~` : `**${title}**`;
  return `- ${text}${where} · _${AGENT_LABELS[item.agent]}_${why}`;
}

/**
 * What became of the previous review's findings (FR-37): resolved, still applicable, no longer evaluated. A
 * finding the run could not look at is never called resolved. Human review threads are not touched (FR-38): this
 * is text in the one comment the App maintains.
 */
function trackingSection(input: SummaryInput): string[] {
  const { tracking } = input;
  if (!tracking || tracking.items.length === 0) return [];
  const counts = countTracked(tracking.items);
  const fresh = Math.max(0, input.findings.length - counts.still_applicable);
  const headline = [
    `**${counts.resolved} resolved**`,
    `${counts.still_applicable} still applicable`,
    `${counts.not_evaluated} no longer evaluated`,
    `${fresh} new`,
  ].join(", ");
  const out = [
    "### Since the previous review",
    `Compared with commit ${codeSpan(shortSha(tracking.previousHeadSha))}: ${headline}.`,
  ];
  const groups: Array<[FindingTracking["items"][number]["state"], string]> = [
    ["resolved", "Resolved"],
    ["still_applicable", "Still applicable"],
    ["not_evaluated", "No longer evaluated"],
  ];
  for (const [state, label] of groups) {
    const items = tracking.items.filter((i) => i.state === state);
    if (items.length === 0) continue;
    const lines = items.slice(0, MAX_TRACKED_LISTED).map(trackedItem);
    if (items.length > MAX_TRACKED_LISTED) {
      lines.push(
        `- …and ${items.length - MAX_TRACKED_LISTED} more (see the run in the dashboard).`,
      );
    }
    out.push(details(`${label} (${items.length})`, lines.join("\n")));
  }
  return out;
}

function notesSection(input: SummaryInput): string[] {
  const notes = input.observations.slice(0, MAX_NOTES).map((o) => {
    const text = sanitizeText(o.text, { maxChars: 300 }).replace(/\n+/g, " ");
    return `- ${text} _(${AGENT_LABELS[o.agent]})_`;
  });
  return notes.length === 0 ? [] : [details(`Notes (${notes.length})`, notes.join("\n"))];
}

function skippedSection(files: readonly SkippedFile[]): string[] {
  if (files.length === 0) return [];
  const lines = files
    .slice(0, MAX_LISTED_FILES)
    .map((f) => `- ${codeSpan(f.path)}: ${sanitizeLine(f.reason, 200)}`);
  if (files.length > MAX_LISTED_FILES) {
    lines.push(`- …and ${files.length - MAX_LISTED_FILES} more.`);
  }
  return [details(`Files not reviewed (${files.length})`, lines.join("\n"))];
}

function warningsSection(warnings: readonly string[]): string[] {
  if (warnings.length === 0) return [];
  const lines = warnings.slice(0, 20).map((w) => `- ${sanitizeLine(w, 300)}`);
  if (warnings.length > 20) lines.push(`- …and ${warnings.length - 20} more.`);
  return ["### Warnings", lines.join("\n")];
}

function suppressedLine(counts: Partial<Record<SuppressReason, number>>): string[] {
  const parts = (Object.keys(SUPPRESS_LABELS) as SuppressReason[])
    .filter((r) => (counts[r] ?? 0) > 0)
    .map((r) => `${counts[r]} ${SUPPRESS_LABELS[r]}`);
  return parts.length === 0 ? [] : [`<sub>Left out: ${parts.join(", ")}.</sub>`];
}

function render(input: SummaryInput, level: Level): string {
  const counts = countBySeverity(input.findings.map((f) => f.finding));
  const total = input.findings.length;
  const parts: string[] = [
    SUMMARY_MARKER_TEXT,
    "## AI PR Review",
    `**Status:** ${STATUS_LABELS[input.status]} · commit ${codeSpan(shortSha(input.headSha))}`,
    headline(input, total, counts),
  ];

  if (input.isDraft) {
    parts.push(
      "_Draft pull request: findings are listed here only. Inline comments are off for drafts._",
    );
  }
  if (input.limitReason) {
    parts.push(`_Limited review: ${sanitizeLine(input.limitReason, 400)}_`);
  }
  if (input.inlineCapped > 0) {
    parts.push(
      `_${plural(input.inlineCapped, "finding")} not posted inline because of the inline comment limit; listed below._`,
    );
  }

  if (total > 0) {
    parts.push(
      "| Critical | High | Medium | Low | Info |\n|:-:|:-:|:-:|:-:|:-:|\n" +
        `| ${SEVERITY_ORDER.map((s) => counts[s]).join(" | ")} |`,
    );
  }
  const calledOut = new Set(
    securityStatus(
      input.findings.map((f) => f.finding),
      securityStateOf(input),
    ).callouts.map((f) => f.id),
  );
  parts.push(
    ...(input.enforcement ? [input.enforcement] : []),
    ...securitySection(input, level),
    ...findingsSection(input.findings, level, calledOut),
    ...trackingSection(input),
    ...coverageSection(input.coverage),
    ...testSection(input.findings, level),
    ...checksSection(input),
    ...notesSection(input),
    ...skippedSection(input.skippedFiles),
    ...warningsSection(input.warnings),
    ...suppressedLine(input.suppressedCounts),
  );

  const footer = [
    ...(input.dashboardUrl ? [`[View this run in the dashboard](${input.dashboardUrl})`] : []),
    "Advisory only: AI can be wrong, so verify before acting.",
  ].join(" · ");
  parts.push(`<sub>${footer}</sub>`);
  return parts.join("\n\n");
}

/** Renders the summary comment, shrinking the finding details until it fits in a GitHub comment. */
export function renderSummary(input: SummaryInput): string {
  let body = "";
  for (const level of LEVELS) {
    body = render(input, level);
    if (body.length <= MAX_SUMMARY_CHARS) return body;
  }
  return finalizeBody(body, MAX_SUMMARY_CHARS);
}
