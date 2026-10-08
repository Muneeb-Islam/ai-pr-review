import type { ResolvedConfig } from "@ai-pr-review/shared";

// Review context (design §10). Everything in a `ReviewContext` is safe to send to a model: excluded files are
// gone, secrets are redacted, size limits are applied. It holds no tokens and no environment values.

export type ChangedFileStatus = "added" | "modified" | "removed" | "renamed";

export interface ChangedFile {
  path: string;
  previousPath?: string;
  status: ChangedFileStatus;
  additions: number;
  deletions: number;
  /** Unified diff hunks as GitHub returns them, with high-confidence secrets redacted (line structure intact). */
  patch?: string;
  /** Runs of consecutive added lines, as new-file line numbers. */
  addedLines: Array<{ start: number; end: number }>;
}

export interface SkippedFile {
  path: string;
  reason: string;
}

export interface PriorComment {
  /** GitHub review comment id. */
  id: number;
  fingerprint: string;
  headSha: string;
  path?: string;
}

export interface PriorState {
  /** Fingerprints of every earlier inline comment the App posted on this PR (any head SHA). */
  fingerprints: string[];
  /** The App's maintained summary comment, if one exists. */
  summaryCommentId?: number;
  /** The same comments with their ids and the head SHA they were posted for (lifecycle handling, Phase 13). */
  comments: PriorComment[];
}

export type LimitStatus = "ok" | "limited" | "skipped";

export interface ContextLimits {
  status: LimitStatus;
  /** Why the review is limited or skipped; shown in the summary. Absent when `status` is `ok`. */
  reason?: string;
}

export interface ContextStats {
  /** Files GitHub reports as changed by the PR (before any filtering). */
  changedFiles: number;
  includedFiles: number;
  skippedFiles: number;
  /** Characters of patch text in `files`. */
  patchCharacters: number;
  /** Secrets replaced in patches, PR text and fetched code. Counts only; values are never kept. */
  redactions: number;
}

export interface ReviewContext {
  pr: {
    number: number;
    title: string;
    body: string;
    author: string;
    baseRef: string;
    baseSha: string;
    headSha: string;
    isDraft: boolean;
    isFork: boolean;
  };
  /** Filtered and size-limited; safe to send to a model. */
  files: ChangedFile[];
  skippedFiles: SkippedFile[];
  /** Changed source file → likely test files in the repository at the head SHA. Empty when not collected. */
  testFiles: Record<string, string[]>;
  prior: PriorState;
  limits: ContextLimits;
  /** Effective configuration for this run: defaults < dashboard < repo file from the base branch. */
  config: ResolvedConfig;
  /** Non-sensitive notes for the summary (config file problems, truncated lists, …). */
  warnings: string[];
  stats: ContextStats;
  /** True if `line` (new-file numbering) is an added line of `path` in the diff the model saw. */
  isLineInDiff(path: string, line: number): boolean;
  /** True if both ends are added lines in one hunk, so a multi-line comment can anchor there. */
  isRangeInDiff(path: string, startLine: number, endLine: number): boolean;
  /** GitHub diff position of an added line (for the legacy `position` comment parameter). */
  diffPosition(path: string, line: number): number | undefined;
}
