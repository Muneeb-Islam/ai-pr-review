import type { Finding, Severity } from "@ai-pr-review/shared";
import { fingerprintFinding } from "../validation/fingerprint";

// Scanner extension point (FR-27, decision 7). The platform reviews security with a model and rules of its own;
// it can also take the output of an established tool (CodeQL or Semgrep as SARIF, `npm audit --json`, Trivy,
// Dependabot alerts) and show it next to its own findings. This file is the whole contract: an adapter turns a
// tool's raw output into `Finding[]`, and nothing else in the platform knows the tool exists. No adapter is
// built in and none is required; `stubScannerAdapter` below is the documented starting point.
//
// To add one:
//   1. Implement `ScannerAdapter`. `parse` is pure: no network, no filesystem, no environment. It receives the
//      tool's output as text and the run's context (head commit, the paths the review covers) and returns findings.
//   2. Build each finding with `scannerFinding`, which fills in `agent: "security"`, `category: "security"`, the
//      fingerprint and the commit, so findings from a tool deduplicate against the platform's own.
//   3. Never put a tool's raw message into a finding unread: it is repository-derived text. The publisher
//      sanitises everything it posts, but keep `evidence` to the line that triggered the rule.
//   4. Decide where the output comes from. Nothing fetches it yet: the likely sources are a workflow artifact
//      (the way coverage is read, Phase 11) or an upload to the API, and either needs its own phase.
//   5. Register the adapter where the worker builds the review (a `scanners` option on `runReview`) and feed
//      `parse`'s result into the same validator as the agents' findings, so thresholds and line checks apply.

export type ScannerFormat = "sarif" | "npm-audit" | "other";

export interface ScannerInput {
  format: ScannerFormat;
  /** The tool's output exactly as produced (JSON text for SARIF and `npm audit --json`). */
  content: string;
}

export interface ScannerContext {
  headSha: string;
  /** Repository-relative paths of the files this review covers; a result for any other path is not reportable. */
  paths: ReadonlySet<string>;
}

export interface ScannerResult {
  findings: Finding[];
  /** Results the adapter could not turn into findings, so the summary can say so; never raw tool output. */
  skipped: number;
  /** Fixed sentences for the run's warnings, for example "The report was not valid SARIF". */
  warnings: string[];
}

export interface ScannerAdapter {
  /** Stable name, for logs and the summary ("semgrep", "npm-audit"). */
  readonly id: string;
  /** The formats `parse` accepts. */
  readonly formats: readonly ScannerFormat[];
  /** Pure. Throwing is allowed; the caller treats it as "this tool produced nothing usable". */
  parse(input: ScannerInput, context: ScannerContext): ScannerResult;
}

export interface ScannerFindingFields {
  severity: Severity;
  confidence: number;
  title: string;
  filePath?: string | undefined;
  startLine?: number | undefined;
  endLine?: number | undefined;
  evidence: string;
  impact: string;
  recommendation: string;
}

/** A finding in the shape every other part of the platform expects, with the fingerprint the validator dedupes on. */
export function scannerFinding(fields: ScannerFindingFields, context: ScannerContext): Finding {
  return {
    id: fingerprintFinding({
      category: "security",
      title: fields.title,
      filePath: fields.filePath,
      startLine: fields.startLine,
    }),
    agent: "security",
    category: "security",
    severity: fields.severity,
    confidence: fields.confidence,
    title: fields.title,
    ...(fields.filePath === undefined ? {} : { filePath: fields.filePath }),
    ...(fields.startLine === undefined ? {} : { startLine: fields.startLine }),
    ...(fields.endLine === undefined ? {} : { endLine: fields.endLine }),
    evidence: fields.evidence,
    impact: fields.impact,
    recommendation: fields.recommendation,
    sourceCommitSha: context.headSha,
  };
}

/**
 * A working adapter that finds nothing: the template to copy. A real adapter reads `input.content`, maps each
 * result to `scannerFinding(...)` (the tool's severity to ours, its rule id into the title, its location into
 * `filePath` and `startLine`) and counts what it could not map in `skipped`.
 */
export const stubScannerAdapter: ScannerAdapter = {
  id: "stub",
  formats: ["sarif", "npm-audit", "other"],
  parse() {
    return { findings: [], skipped: 0, warnings: [] };
  },
};
