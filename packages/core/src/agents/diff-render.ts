import { estimateTokens } from "../context/size";
import { parsePatch, type DiffHunk, type DiffLine } from "../context/diff";
import type { ChangedFile } from "../context/types";

// A raw patch makes the model count lines from hunk headers, which it does badly. Every context and added line is
// shown with its new-file number instead, so a line window is as valid as a whole hunk and any hunk can be split.

const NUMBER_WIDTH = 5;

function renderLine(line: DiffLine): string | undefined {
  switch (line.type) {
    case "add":
      return `${String(line.newLine).padStart(NUMBER_WIDTH)} + ${line.content}`;
    case "context":
      return `${String(line.newLine).padStart(NUMBER_WIDTH)}   ${line.content}`;
    case "del":
      return `${" ".repeat(NUMBER_WIDTH)} - ${line.content}`;
    default:
      return undefined; // "\ No newline at end of file"
  }
}

export function fileHeader(file: ChangedFile, continued = false): string {
  const rename = file.previousPath ? `, renamed from ${file.previousPath}` : "";
  const suffix = continued ? " (continued)" : "";
  return `=== FILE: ${file.path} (${file.status}${rename}, +${file.additions} -${file.deletions})${suffix} ===`;
}

/** One unit of a file's diff: a hunk, or a window of lines when a single hunk is too big for a request. */
interface DiffUnit {
  file: ChangedFile;
  text: string;
}

function hunkUnits(file: ChangedFile, hunk: DiffHunk, maxTokens: number): DiffUnit[] {
  const header = `@@ -${hunk.oldStart},${hunk.oldLines} +${hunk.newStart},${hunk.newLines} @@${hunk.heading ? ` ${hunk.heading}` : ""}`;
  const lines = hunk.lines.map(renderLine).filter((line): line is string => line !== undefined);
  const whole = [header, ...lines].join("\n");
  if (estimateTokens(whole) <= maxTokens) return [{ file, text: whole }];

  const units: DiffUnit[] = [];
  let window: string[] = [];
  let tokens = estimateTokens(header);
  const flush = (first: boolean) => {
    if (window.length === 0) return;
    units.push({
      file,
      text: [first ? header : "@@ (same hunk, continued) @@", ...window].join("\n"),
    });
    window = [];
    tokens = estimateTokens("@@ (same hunk, continued) @@");
  };
  for (const line of lines) {
    const cost = estimateTokens(line) + 1;
    if (tokens + cost > maxTokens && window.length > 0) flush(units.length === 0);
    window.push(line);
    tokens += cost;
  }
  flush(units.length === 0);
  return units;
}

/** One text per file section that fits in a chunk. Files without a patch have no units. */
function unitsOf(file: ChangedFile, maxTokens: number): DiffUnit[] {
  if (!file.patch) return [];
  return parsePatch(file.patch).hunks.flatMap((hunk) => hunkUnits(file, hunk, maxTokens));
}

export interface DiffChunk {
  /** Paths with at least one unit in this chunk. */
  paths: string[];
  /** The numbered diff text for this chunk. */
  text: string;
  tokens: number;
}

/**
 * Splits the files' diffs into chunks of at most `maxTokens` estimated tokens each, in file order: whole files
 * where they fit, a file's hunks across chunks where it does not, and a single oversized hunk by line windows.
 * The file header is repeated when a file continues in the next chunk. A unit larger than the budget cannot
 * occur: it is split first.
 */
export function chunkDiff(files: readonly ChangedFile[], maxTokens: number): DiffChunk[] {
  const budget = Math.max(200, Math.floor(maxTokens));
  const chunks: DiffChunk[] = [];
  let sections: string[] = [];
  let paths: string[] = [];
  let tokens = 0;
  let lastFile: ChangedFile | undefined;

  const flush = () => {
    if (sections.length > 0) chunks.push({ paths, text: sections.join("\n\n"), tokens });
    sections = [];
    paths = [];
    tokens = 0;
    lastFile = undefined;
  };

  for (const file of files) {
    let seen = false;
    // Leave room for the header that opens every file section.
    const unitBudget = Math.max(100, budget - estimateTokens(fileHeader(file, true)) - 2);
    for (const unit of unitsOf(file, unitBudget)) {
      const continuing = lastFile === file;
      const header = continuing ? undefined : fileHeader(file, seen);
      const cost = estimateTokens(unit.text) + (header ? estimateTokens(header) + 1 : 0) + 1;
      if (tokens + cost > budget && sections.length > 0) {
        flush();
        const opening = fileHeader(file, seen);
        sections.push(`${opening}\n${unit.text}`);
        tokens = estimateTokens(opening) + estimateTokens(unit.text) + 2;
      } else if (header) {
        sections.push(`${header}\n${unit.text}`);
        tokens += cost;
      } else {
        // Same file as the previous unit: append to its section.
        sections[sections.length - 1] = `${sections[sections.length - 1]}\n${unit.text}`;
        tokens += cost;
      }
      if (!paths.includes(file.path)) paths.push(file.path);
      lastFile = file;
      seen = true;
    }
  }
  flush();
  return chunks;
}

/**
 * The numbered lines of one file's diff around `line` (new-file numbering), for a reader who judges a single spot
 * and must not pay for the whole diff. The window is `radius` rendered lines either side, inside the hunk that
 * holds the line (the first hunk when `line` is absent or not in any hunk). Empty when the file has no patch.
 */
export function renderExcerpt(file: ChangedFile, line: number | undefined, radius: number): string {
  if (!file.patch) return "";
  const hunks = parsePatch(file.patch).hunks;
  const hunk =
    (line === undefined ? undefined : hunks.find((h) => h.lines.some((l) => l.newLine === line))) ??
    hunks[0];
  if (!hunk) return "";
  const rows = hunk.lines
    .map((l) => ({ l, text: renderLine(l) }))
    .filter((r): r is { l: DiffLine; text: string } => r.text !== undefined);
  const at = line === undefined ? -1 : rows.findIndex((r) => r.l.newLine === line);
  const from = at < 0 ? 0 : Math.max(0, at - radius);
  const to =
    at < 0 ? Math.min(rows.length, radius * 2 + 1) : Math.min(rows.length, at + radius + 1);
  return rows
    .slice(from, to)
    .map((r) => r.text)
    .join("\n");
}
