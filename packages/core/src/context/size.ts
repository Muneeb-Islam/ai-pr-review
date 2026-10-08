import type { ChangedFile, ContextLimits, SkippedFile } from "./types";

/** Code tokenises at roughly 3 to 4 characters per token; the low end keeps budgets on the safe side. */
export const CHARS_PER_TOKEN = 3.5;

/**
 * Rough token count for budgeting a request (Phase 6). Over-estimates slightly on purpose; the provider's
 * reported usage is authoritative.
 */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / CHARS_PER_TOKEN);
}

/** Tokens needed to send these files' patches (path and framing overhead included). */
export function estimateFilesTokens(files: readonly Pick<ChangedFile, "path" | "patch">[]): number {
  let total = 0;
  for (const file of files)
    total += estimateTokens(file.path) + estimateTokens(file.patch ?? "") + 8;
  return total;
}

/** A PR more than this many times over a limit is skipped: too little of it would be reviewed to be useful. */
export const SKIP_MULTIPLE = 5;

export interface SizeCandidate {
  file: ChangedFile;
  /** Lower comes first (source before tests before config before docs). */
  priority: number;
}

export interface SizeInput {
  candidates: SizeCandidate[];
  maxChangedFiles: number;
  maxPatchCharacters: number;
}

export interface SizeResult {
  included: ChangedFile[];
  skipped: SkippedFile[];
  limits: ContextLimits;
}

const plural = (n: number, word: string): string => `${n} ${word}${n === 1 ? "" : "s"}`;

/**
 * Enforces `max_changed_files` and `max_patch_characters` (FR-09). Files are taken in priority order, then
 * by path so the result is stable; a file that does not fit is skipped and smaller ones after it can still
 * fit. `included` keeps the original file order.
 *
 * - `ok`: everything fits.
 * - `limited`: some files were left out; the reason says how many and why.
 * - `skipped`: nothing fits, or the PR is more than `SKIP_MULTIPLE` times over a limit.
 */
export function applySizePolicy(input: SizeInput): SizeResult {
  const { candidates, maxChangedFiles, maxPatchCharacters } = input;
  const totalChars = candidates.reduce((sum, c) => sum + (c.file.patch?.length ?? 0), 0);

  if (candidates.length <= maxChangedFiles && totalChars <= maxPatchCharacters) {
    return { included: candidates.map((c) => c.file), skipped: [], limits: { status: "ok" } };
  }

  const overFiles = candidates.length > maxChangedFiles;
  const overChars = totalChars > maxPatchCharacters;

  const order = candidates
    .map((candidate, index) => ({ ...candidate, index }))
    .sort(
      (a, b) =>
        a.priority - b.priority || a.file.path.localeCompare(b.file.path) || a.index - b.index,
    );

  const keep = new Set<number>();
  const skipped: SkippedFile[] = [];
  let usedChars = 0;
  let tooLarge = 0;
  let tooMany = 0;
  let outOfBudget = 0;

  for (const entry of order) {
    const length = entry.file.patch?.length ?? 0;
    if (keep.size >= maxChangedFiles) {
      tooMany += 1;
      skipped.push({
        path: entry.file.path,
        reason: `over the limit of ${plural(maxChangedFiles, "changed file")}`,
      });
    } else if (length > maxPatchCharacters) {
      tooLarge += 1;
      skipped.push({
        path: entry.file.path,
        reason: `patch alone is larger than the limit of ${maxPatchCharacters} characters`,
      });
    } else if (usedChars + length > maxPatchCharacters) {
      outOfBudget += 1;
      skipped.push({
        path: entry.file.path,
        reason: `over the patch size limit of ${maxPatchCharacters} characters`,
      });
    } else {
      keep.add(entry.index);
      usedChars += length;
    }
  }

  const included = candidates.filter((_, index) => keep.has(index)).map((c) => c.file);
  const causes: string[] = [];
  if (overFiles)
    causes.push(`${plural(candidates.length, "file")} changed (limit ${maxChangedFiles})`);
  if (overChars) causes.push(`${totalChars} patch characters (limit ${maxPatchCharacters})`);
  const overview = `This pull request is large: ${causes.join(" and ")}.`;

  const hardOver =
    candidates.length > maxChangedFiles * SKIP_MULTIPLE ||
    totalChars > maxPatchCharacters * SKIP_MULTIPLE;

  if (included.length === 0 || hardOver) {
    return {
      included: [],
      skipped: candidates.map((c) => ({
        path: c.file.path,
        reason: "pull request too large to review",
      })),
      limits: {
        status: "skipped",
        reason: `${overview} It is too large to review reliably, so no files were reviewed.`,
      },
    };
  }

  const parts: string[] = [];
  if (tooMany > 0) parts.push(`${plural(tooMany, "file")} over the file limit`);
  if (tooLarge > 0) parts.push(`${plural(tooLarge, "file")} with a patch over the size limit`);
  if (outOfBudget > 0)
    parts.push(`${plural(outOfBudget, "file")} that did not fit the size budget`);
  return {
    included,
    skipped,
    limits: {
      status: "limited",
      reason: `${overview} Reviewed ${included.length} of ${candidates.length} files, source and tests first; left out ${parts.join(", ")}.`,
    },
  };
}
