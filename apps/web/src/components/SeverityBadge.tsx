import type { Severity } from "@ai-pr-review/shared";

const STYLES: Record<Severity, { label: string; classes: string }> = {
  critical: { label: "Critical", classes: "bg-sev-critical-bg text-sev-critical-fg" },
  high: { label: "High", classes: "bg-sev-high-bg text-sev-high-fg" },
  medium: { label: "Medium", classes: "bg-sev-medium-bg text-sev-medium-fg" },
  low: { label: "Low", classes: "bg-sev-low-bg text-sev-low-fg" },
  info: { label: "Info", classes: "bg-sev-info-bg text-sev-info-fg" },
};

export const SEVERITY_ORDER: Severity[] = ["critical", "high", "medium", "low", "info"];

export function SeverityBadge({ severity }: { severity: Severity }) {
  const { label, classes } = STYLES[severity];
  return (
    <span
      data-severity={severity}
      className={`inline-flex items-center rounded border border-current/20 px-1.5 py-0.5 text-xs font-semibold whitespace-nowrap ${classes}`}
    >
      {label}
    </span>
  );
}

/** "1 critical · 2 high": the findings of a run in words, most severe first. */
export function SeverityCounts({ counts }: { counts: Record<Severity, number> }) {
  const parts = SEVERITY_ORDER.filter((s) => counts[s] > 0).map((s) => `${counts[s]} ${s}`);
  if (parts.length === 0) return <span className="text-muted">No findings</span>;
  return <span>{parts.join(" · ")}</span>;
}
