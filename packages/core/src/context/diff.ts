// Unified-diff parsing for the `patch` field GitHub returns per file (no `diff --git` / `---` / `+++` lines).

export type DiffLineType = "add" | "del" | "context" | "meta";

export interface DiffLine {
  type: DiffLineType;
  /** Text without the leading `+`, `-` or space. */
  content: string;
  /** Line number in the old file (`del`, `context`). */
  oldLine?: number;
  /** Line number in the new file (`add`, `context`). */
  newLine?: number;
  /** GitHub diff position: the line after the first `@@` is 1, later hunk headers count too. */
  position: number;
}

export interface DiffHunk {
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  /** The text after the closing `@@` (usually the enclosing function signature). */
  heading: string;
  lines: DiffLine[];
}

export interface FileDiff {
  hunks: DiffHunk[];
}

const HUNK_HEADER = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(.*)$/;

/**
 * Parses one file's patch into hunks with old/new line numbers and diff positions. Handles several hunks,
 * additions, deletions, `\ No newline at end of file` markers and CRLF. Lines before the first `@@` are ignored.
 */
export function parsePatch(patch: string): FileDiff {
  const hunks: DiffHunk[] = [];
  let hunk: DiffHunk | undefined;
  let oldLine = 0;
  let newLine = 0;
  let position = 0;
  let started = false;

  const rows = patch.split("\n");
  // A trailing newline leaves an empty last element that is not a diff line.
  if (rows.length > 0 && rows[rows.length - 1] === "") rows.pop();

  for (const rawRow of rows) {
    const row = rawRow.endsWith("\r") ? rawRow.slice(0, -1) : rawRow;
    const header = HUNK_HEADER.exec(row);
    if (header) {
      if (started) position += 1;
      started = true;
      hunk = {
        oldStart: Number(header[1]),
        oldLines: header[2] === undefined ? 1 : Number(header[2]),
        newStart: Number(header[3]),
        newLines: header[4] === undefined ? 1 : Number(header[4]),
        heading: (header[5] ?? "").trim(),
        lines: [],
      };
      oldLine = hunk.oldStart;
      newLine = hunk.newStart;
      hunks.push(hunk);
      continue;
    }
    if (!hunk) continue;

    position += 1;
    const marker = row[0];
    const content = row.slice(1);
    if (marker === "+") {
      hunk.lines.push({ type: "add", content, newLine, position });
      newLine += 1;
    } else if (marker === "-") {
      hunk.lines.push({ type: "del", content, oldLine, position });
      oldLine += 1;
    } else if (marker === "\\") {
      hunk.lines.push({ type: "meta", content: row, position });
    } else {
      // A context line starts with a space; some tools strip it from empty lines.
      hunk.lines.push({
        type: "context",
        content: marker === " " ? content : row,
        oldLine,
        newLine,
        position,
      });
      oldLine += 1;
      newLine += 1;
    }
  }
  return { hunks };
}

/** Runs of consecutive added lines, as new-file line numbers. */
export function addedLineRanges(diff: FileDiff): Array<{ start: number; end: number }> {
  const ranges: Array<{ start: number; end: number }> = [];
  for (const hunk of diff.hunks) {
    for (const line of hunk.lines) {
      if (line.type !== "add" || line.newLine === undefined) continue;
      const last = ranges[ranges.length - 1];
      if (last && last.end + 1 === line.newLine) last.end = line.newLine;
      else ranges.push({ start: line.newLine, end: line.newLine });
    }
  }
  return ranges;
}

interface IndexedFile {
  /** Added line → position in the diff. */
  added: Map<number, number>;
  /** Added line → index of its hunk. */
  hunkOf: Map<number, number>;
}

/** Lookup of added lines per file; the source of `isLineInDiff` and friends. Built from the files a model sees. */
export class DiffIndex {
  private readonly files = new Map<string, IndexedFile>();

  add(path: string, patch: string | undefined): void {
    const added = new Map<number, number>();
    const hunkOf = new Map<number, number>();
    if (patch) {
      parsePatch(patch).hunks.forEach((hunk, index) => {
        for (const line of hunk.lines) {
          if (line.type === "add" && line.newLine !== undefined) {
            added.set(line.newLine, line.position);
            hunkOf.set(line.newLine, index);
          }
        }
      });
    }
    this.files.set(path, { added, hunkOf });
  }

  /** An added line of this file in the new-file numbering. Unchanged and deleted lines are not in the diff. */
  isLineInDiff(path: string, line: number): boolean {
    return this.files.get(path)?.added.has(line) ?? false;
  }

  /** Both ends are added lines of the same hunk (what a multi-line review comment needs). */
  isRangeInDiff(path: string, startLine: number, endLine: number): boolean {
    const file = this.files.get(path);
    if (!file || endLine < startLine) return false;
    const hunk = file.hunkOf.get(startLine);
    return hunk !== undefined && file.hunkOf.get(endLine) === hunk && file.added.has(endLine);
  }

  position(path: string, line: number): number | undefined {
    return this.files.get(path)?.added.get(line);
  }
}
