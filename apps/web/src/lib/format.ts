import type { RunStatus } from "@ai-pr-review/shared";

const relative = new Intl.RelativeTimeFormat("en", { numeric: "auto" });

const UNITS: Array<[Intl.RelativeTimeFormatUnit, number]> = [
  ["year", 365 * 24 * 3600],
  ["month", 30 * 24 * 3600],
  ["day", 24 * 3600],
  ["hour", 3600],
  ["minute", 60],
  ["second", 1],
];

/** "5 minutes ago", "in 2 hours", "now". */
export function formatRelative(iso: string, now: number): string {
  const seconds = Math.round((new Date(iso).getTime() - now) / 1000);
  if (Math.abs(seconds) < 5) return "just now";
  for (const [unit, size] of UNITS) {
    if (Math.abs(seconds) >= size) return relative.format(Math.round(seconds / size), unit);
  }
  return "just now";
}

/** The exact local time, for a tooltip. */
export function formatExact(iso: string): string {
  return new Date(iso).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "medium" });
}

/** "420 ms", "3 s", "1 m 12 s", "2 h 5 m". Negative or invalid values read as "0 s". */
export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return "0 s";
  if (ms < 1000) return `${Math.round(ms)} ms`;
  const total = Math.round(ms / 1000);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (h > 0) return m > 0 ? `${h} h ${m} m` : `${h} h`;
  if (m > 0) return s > 0 ? `${m} m ${s} s` : `${m} m`;
  return `${s} s`;
}

export const formatNumber = (n: number): string => n.toLocaleString("en-US");

export const shortSha = (sha: string): string => sha.slice(0, 7);

export const STATUS_LABELS: Record<RunStatus, string> = {
  queued: "Queued",
  running: "Running",
  completed: "Completed",
  partial: "Partial",
  failed: "Failed",
  skipped: "Skipped",
  superseded: "Superseded",
  cancelled: "Cancelled",
};

export const isActive = (status: RunStatus): boolean => status === "queued" || status === "running";

export const TRIGGER_LABELS: Record<string, string> = {
  pull_request: "Pull request event",
  comment_command: "Comment command",
  check_run_rerequested: "Check Run re-run",
  dashboard_rerun: "Dashboard re-run",
};

export const AGENT_LABELS: Record<string, string> = {
  code_review: "Code Review",
  test_coverage: "Test Coverage",
  security: "Security",
  final_review: "Final Review",
};

export const AGENT_STATUS_LABELS: Record<string, string> = {
  ok: "OK",
  failed: "Failed",
  timeout: "Timed out",
  invalid_output: "Invalid output",
};

export const CATEGORY_LABELS: Record<string, string> = {
  bug: "Bug",
  security: "Security",
  test_gap: "Test gap",
  performance: "Performance",
  maintainability: "Maintainability",
};

export const SUPPRESS_LABELS: Record<string, string> = {
  below_threshold: "below the thresholds",
  invalid_line: "not on a changed line",
  no_evidence: "without evidence",
  duplicate: "duplicates",
  style_only: "style only",
  rejected_by_final_review: "rejected by the final review",
};

export const FEEDBACK_LABELS: Record<string, string> = {
  useful: "Useful",
  false_positive: "False positive",
  known: "Already known",
};

export const FINDING_STATUS_LABELS: Record<string, string> = {
  posted: "Posted as an inline comment",
  summary_only: "In the summary only",
  suppressed: "Not reported (suppressed)",
  all: "All, including suppressed",
};

/** Audit actions in words; an unknown action is shown as it is. */
export const AUDIT_ACTION_LABELS: Record<string, string> = {
  "settings.update": "Changed repository settings",
  "installation.settings.update": "Changed installation settings",
  "credential.put": "Set a provider key",
  "credential.delete": "Removed a provider key",
  "run.rerun": "Re-ran a review",
  "run.cancel": "Cancelled a review",
  "export.csv": "Exported CSV",
};

/** 0.9532 becomes "95%"; one decimal below 10% ("4.5%") so small rates are not rounded away. */
export function formatPercent(share: number): string {
  const pct = share * 100;
  return `${pct < 10 && pct > 0 ? pct.toFixed(1).replace(/\.0$/, "") : Math.round(pct)}%`;
}

/** Whole dollars above $100, cents below, and "under $0.01" for a sliver. */
export function formatUsd(amount: number): string {
  if (amount > 0 && amount < 0.01) return "under $0.01";
  return `$${amount.toLocaleString("en-US", { minimumFractionDigits: amount >= 100 ? 0 : 2, maximumFractionDigits: amount >= 100 ? 0 : 2 })}`;
}

/** The place of a finding: `src/a.ts:10–12`. */
export function formatPlace(f: {
  file_path: string | null;
  start_line: number | null;
  end_line: number | null;
}): string | undefined {
  if (!f.file_path) return undefined;
  if (f.start_line === null) return f.file_path;
  return f.end_line !== null && f.end_line !== f.start_line
    ? `${f.file_path}:${f.start_line}–${f.end_line}`
    : `${f.file_path}:${f.start_line}`;
}
