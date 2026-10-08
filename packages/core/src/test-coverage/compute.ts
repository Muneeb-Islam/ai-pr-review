import type { CoverageFile, CoverageSummary, LineRange } from "@ai-pr-review/shared";
import type { ChangedFile } from "../context/types";
import type { LcovFile, LcovReport } from "./lcov";
import { matchReportFiles } from "./paths";

// Changed-file and changed-line coverage (FR-22): the lines a pull request added, intersected with the lines the
// report counts as executable. A changed line that is not in the report's `DA` records is not executable (a
// comment, a brace, a type) and says nothing about coverage either way.

const MAX_RANGES_PER_FILE = 25;
const MAX_FUNCTION_NAMES = 10;

/** Consecutive line numbers folded into ranges. */
export function toRanges(lines: readonly number[]): LineRange[] {
  const sorted = [...new Set(lines)].sort((a, b) => a - b);
  const ranges: LineRange[] = [];
  for (const line of sorted) {
    const last = ranges[ranges.length - 1];
    if (last && line === last.end + 1) last.end = line;
    else ranges.push({ start: line, end: line });
  }
  return ranges;
}

function addedLineNumbers(file: Pick<ChangedFile, "addedLines">): number[] {
  const lines: number[] = [];
  for (const range of file.addedLines) {
    for (let line = range.start; line <= range.end; line += 1) lines.push(line);
  }
  return lines;
}

function measureFile(
  file: Pick<ChangedFile, "path" | "addedLines">,
  record: LcovFile,
): CoverageFile {
  const changed = new Set(addedLineNumbers(file));
  let covered = 0;
  let total = 0;
  const uncovered: number[] = [];
  for (const line of changed) {
    const hits = record.lines.get(line);
    if (hits === undefined) continue;
    total += 1;
    if (hits > 0) covered += 1;
    else uncovered.push(line);
  }

  const uncoveredFunctions = record.functions
    .filter((fn) => fn.hits === 0 && changed.has(fn.line))
    .map((fn) => fn.name)
    .slice(0, MAX_FUNCTION_NAMES);

  const branches = record.branches.filter((b) => changed.has(b.line));
  const ranges = toRanges(uncovered);
  return {
    path: file.path,
    status: "measured",
    coveredLines: covered,
    totalLines: total,
    uncovered: ranges.slice(0, MAX_RANGES_PER_FILE),
    ...(uncoveredFunctions.length > 0 ? { uncoveredFunctions } : {}),
    ...(branches.length > 0
      ? {
          coveredBranches: branches.filter((b) => b.taken).length,
          totalBranches: branches.length,
        }
      : {}),
  };
}

export interface ChangedCoverage {
  summary: CoverageSummary;
  /** The rule used to match report paths to repository paths, for logs. */
  pathRule: string;
  /** Number of files in the report that no changed file claimed (informational). */
  reportFiles: number;
}

/**
 * Coverage of the changed lines of `files` (the pull request's changed source files) from a parsed report.
 * Files the report does not hold are listed as `not_in_report`: unknown, not zero. The percentage counts only
 * executable changed lines in matched files; with none, there is no percentage.
 */
export function computeChangedCoverage(
  files: ReadonlyArray<Pick<ChangedFile, "path" | "addedLines">>,
  report: LcovReport,
): ChangedCoverage {
  const match = matchReportFiles(
    files.map((f) => f.path),
    report.files,
  );

  const entries: CoverageFile[] = files.map((file) => {
    const record = match.matched.get(file.path);
    return record
      ? measureFile(file, record)
      : {
          path: file.path,
          status: "not_in_report" as const,
          coveredLines: 0,
          totalLines: 0,
          uncovered: [],
        };
  });

  const measured = entries.filter((e) => e.status === "measured");
  const covered = measured.reduce((sum, e) => sum + e.coveredLines, 0);
  const total = measured.reduce((sum, e) => sum + e.totalLines, 0);

  const observations: string[] = [];
  const missing = entries.length - measured.length;
  if (missing > 0) {
    observations.push(
      `${missing} changed ${missing === 1 ? "file is" : "files are"} not in the coverage report, so ${missing === 1 ? "its" : "their"} coverage is unknown.`,
    );
  }
  if (measured.length > 0 && total === 0) {
    observations.push("None of the changed lines in the report are executable code.");
  }

  // Least covered first, so the worst files lead the summary and survive any cap.
  entries.sort((a, b) => {
    const rank = (e: CoverageFile): number =>
      e.status === "not_in_report" ? 2 : e.totalLines === 0 ? 1 : 0;
    if (rank(a) !== rank(b)) return rank(a) - rank(b);
    const share = (e: CoverageFile): number =>
      e.totalLines === 0 ? 1 : e.coveredLines / e.totalLines;
    return share(a) - share(b) || a.path.localeCompare(b.path);
  });

  return {
    summary: {
      status: "measured",
      ...(total > 0 ? { changedLineCoverage: covered / total } : {}),
      coveredLines: covered,
      totalLines: total,
      files: entries,
      observations,
    },
    pathRule: match.rule,
    reportFiles: report.files.length,
  };
}
