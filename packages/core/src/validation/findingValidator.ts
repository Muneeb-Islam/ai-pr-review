import type { Finding, ResolvedConfig, SuppressReason } from "@ai-pr-review/shared";
import type { ReviewContext } from "../context/types";
import { dedupeByFingerprint } from "./dedupe";
import { meetsSeverity } from "./severity";

export interface SuppressedFinding {
  finding: Finding;
  reason: SuppressReason;
}

export interface ValidationResult {
  /** Findings that may be posted, most severe first. A finding's line range may have been narrowed (see `place`). */
  accepted: Finding[];
  suppressed: SuppressedFinding[];
}

/** Design §10. */
export interface FindingValidator {
  validate(findings: Finding[], ctx: ReviewContext, cfg: ResolvedConfig): ValidationResult;
}

/** Words that mark a finding as a formatting or linter complaint (FR-19). Matched on title and impact. */
const STYLE_PATTERN =
  /\b(?:whitespace|indentation|indent|semicolons?|trailing (?:commas?|spaces?|whitespace)|(?:single|double) quotes?|quote style|line length|max-len|prettier|eslint|tslint|linters?|linting|formatting|formatted|code style|coding style|style guide|style convention|naming conventions?|camel ?case|snake ?case|pascal ?case|import order|sort(?:ed|ing)? imports?|blank lines?|brace style|tabs? (?:vs\.?|or|instead of) spaces|missing (?:jsdoc|docstrings?|comments?|documentation))\b/i;

/** Impact text that says nothing happens. */
const NO_IMPACT_PATTERN =
  /^\W*(?:none|n\/?a|nothing|no (?:real |direct |functional |significant )?impact|no effect|negligible|unknown|not applicable|tbd)\W*$/i;

/** Evidence or impact shorter than this cannot say what is wrong. */
const MIN_TEXT_LENGTH = 3;

function hasEvidenceAndImpact(finding: Finding): boolean {
  const evidence = finding.evidence.trim();
  const impact = finding.impact.trim();
  return (
    evidence.length >= MIN_TEXT_LENGTH &&
    impact.length >= MIN_TEXT_LENGTH &&
    !NO_IMPACT_PATTERN.test(impact)
  );
}

/** Formatting and linter complaints are not worth a reviewer's time. Real defects are never "style only". */
export function isStyleOnly(finding: Finding): boolean {
  if (finding.category !== "maintainability") return false;
  return STYLE_PATTERN.test(finding.title) || STYLE_PATTERN.test(finding.impact);
}

type Placement = { ok: true; finding: Finding } | { ok: false };

/**
 * Checks where a finding points. A path must be a file the model saw, and the start line must be an added line
 * of it (FR-17); a finding with no path is a general finding and stays. If only the end of the range is not
 * valid (it crosses a hunk, or is above the start) the range is narrowed to the start line, which keeps a good
 * finding instead of dropping it for an imprecise end.
 */
function place(finding: Finding, ctx: ReviewContext): Placement {
  const { filePath, startLine, endLine } = finding;
  if (filePath === undefined) {
    return startLine === undefined && endLine === undefined ? { ok: true, finding } : { ok: false };
  }
  if (!ctx.files.some((file) => file.path === filePath)) return { ok: false };
  if (startLine === undefined) return endLine === undefined ? { ok: true, finding } : { ok: false };
  if (!ctx.isLineInDiff(filePath, startLine)) return { ok: false };
  if (endLine === undefined || endLine === startLine) return { ok: true, finding };
  if (ctx.isRangeInDiff(filePath, startLine, endLine)) return { ok: true, finding };
  return { ok: true, finding: { ...finding, endLine: startLine } };
}

/**
 * The checks of FR-19, in this order: evidence and impact present, path and lines in the diff, not style-only,
 * meets the configured minimum severity and confidence, not a duplicate within the run. Each finding gets the
 * first reason that applies. Deduplication runs last so a finding that was dropped for another reason cannot hide
 * a good one with the same fingerprint.
 *
 * A finding that earlier comments on the pull request already say is NOT a duplicate here (Phase 13): it is still a
 * finding of this run, counted, summarised as "still applicable" and enforced on. Not posting it again is the
 * publisher's job (`planInline`), which knows which comments are on the PR.
 */
export function validateFindings(
  findings: readonly Finding[],
  ctx: ReviewContext,
  cfg: ResolvedConfig,
): ValidationResult {
  const suppressed: SuppressedFinding[] = [];
  const survivors: Finding[] = [];
  const drop = (finding: Finding, reason: SuppressReason) => suppressed.push({ finding, reason });

  for (const original of findings) {
    if (!hasEvidenceAndImpact(original)) {
      drop(original, "no_evidence");
      continue;
    }
    const placed = place(original, ctx);
    if (!placed.ok) {
      drop(original, "invalid_line");
      continue;
    }
    const finding = placed.finding;
    if (isStyleOnly(finding)) {
      drop(finding, "style_only");
      continue;
    }
    if (
      !meetsSeverity(finding.severity, cfg.review.minimum_severity) ||
      finding.confidence < cfg.review.minimum_confidence
    ) {
      drop(finding, "below_threshold");
      continue;
    }
    survivors.push(finding);
  }

  const { unique, duplicates } = dedupeByFingerprint(survivors);
  for (const finding of duplicates) drop(finding, "duplicate");
  return { accepted: unique, suppressed };
}

export const findingValidator: FindingValidator = {
  validate: (findings, ctx, cfg) => validateFindings(findings, ctx, cfg),
};

/** Counts per reason, with every reason present so a stored record always has the same shape. */
export function countSuppressed(
  suppressed: readonly SuppressedFinding[],
): Record<SuppressReason, number> {
  const counts: Record<SuppressReason, number> = {
    below_threshold: 0,
    invalid_line: 0,
    no_evidence: 0,
    duplicate: 0,
    style_only: 0,
    rejected_by_final_review: 0,
  };
  for (const { reason } of suppressed) counts[reason] += 1;
  return counts;
}
