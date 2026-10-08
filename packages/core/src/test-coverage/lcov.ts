// LCOV tracefile parser (FR-22). Jest (istanbul) and Vitest (istanbul or v8) both write this format. The parser
// is tolerant: a line it does not understand is counted and skipped, and the same file appearing in several
// records (merged reports) is added up. It reads text only; it never touches the filesystem.

export interface LcovFunction {
  name: string;
  /** Line of the declaration. */
  line: number;
  hits: number;
}

export interface LcovBranch {
  line: number;
  /** `false` for `-` (the branch was never reached) and for a count of zero. */
  taken: boolean;
}

export interface LcovFile {
  /** The path exactly as the report wrote it (`SF:`). Normalising it is `paths.ts`'s job. */
  path: string;
  /** Execution count per executable line (`DA:`). A line that is absent is not executable. */
  lines: Map<number, number>;
  functions: LcovFunction[];
  /** Empty when the report has no branch data. */
  branches: LcovBranch[];
}

export interface LcovReport {
  files: LcovFile[];
  /** Lines the parser did not understand. */
  malformedLines: number;
}

export type LcovErrorCode = "empty" | "invalid" | "too_many_files";

/** The text is not a usable LCOV report. The message never includes any of the text. */
export class LcovError extends Error {
  constructor(
    readonly code: LcovErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "LcovError";
  }
}

export const MAX_LCOV_FILES = 20_000;
/** A line number or hit count above this is garbage, not coverage data. */
const MAX_LINE_NUMBER = 10_000_000;

function toInt(text: string | undefined): number | undefined {
  if (text === undefined || !/^\d+$/.test(text.trim())) return undefined;
  const value = Number(text.trim());
  return Number.isSafeInteger(value) ? value : undefined;
}

interface Builder {
  path: string;
  lines: Map<number, number>;
  functions: Map<string, LcovFunction>;
  branches: Map<string, LcovBranch>;
}

function finish(builder: Builder): LcovFile {
  return {
    path: builder.path,
    lines: builder.lines,
    functions: [...builder.functions.values()],
    branches: [...builder.branches.values()],
  };
}

/**
 * Parses an LCOV report. Throws `LcovError` for empty text, or for text with no `SF:` record at all (so it is not
 * LCOV, for example an HTML page or JSON). Records without lines, which tools write for files that were never
 * loaded, are kept: they say the file is in the report with nothing executable.
 */
export function parseLcov(text: string, options: { maxFiles?: number } = {}): LcovReport {
  const maxFiles = options.maxFiles ?? MAX_LCOV_FILES;
  if (text.trim() === "") throw new LcovError("empty", "The coverage report is empty.");

  const files = new Map<string, LcovFile>();
  let malformed = 0;
  let current: Builder | undefined;

  const close = () => {
    if (!current) return;
    const done = finish(current);
    const earlier = files.get(done.path);
    if (!earlier) {
      files.set(done.path, done);
    } else {
      // The same file reported twice (merged reports): execution counts add up.
      for (const [line, hits] of done.lines) {
        earlier.lines.set(line, (earlier.lines.get(line) ?? 0) + hits);
      }
      const seen = new Map(earlier.functions.map((f) => [`${f.name}:${f.line}`, f]));
      for (const fn of done.functions) {
        const known = seen.get(`${fn.name}:${fn.line}`);
        if (known) known.hits += fn.hits;
        else earlier.functions.push(fn);
      }
      earlier.branches.push(...done.branches);
    }
    current = undefined;
    if (files.size > maxFiles) {
      throw new LcovError("too_many_files", "The coverage report lists too many files.");
    }
  };

  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (line === "") continue;
    const colon = line.indexOf(":");
    const tag = colon === -1 ? line : line.slice(0, colon);
    const value = colon === -1 ? "" : line.slice(colon + 1);

    switch (tag) {
      case "TN":
      case "FNF":
      case "FNH":
      case "BRF":
      case "BRH":
      case "LF":
      case "LH":
      case "VER":
        break; // totals are recomputed from the records; the test name is irrelevant
      case "SF":
        close();
        if (value === "") malformed += 1;
        else {
          current = {
            path: value,
            lines: new Map(),
            functions: new Map(),
            branches: new Map(),
          };
        }
        break;
      case "end_of_record":
        close();
        break;
      case "DA": {
        // DA:<line>,<hits>[,<checksum>]
        const [lineText, hitsText] = value.split(",");
        const lineNumber = toInt(lineText);
        // Some tools write a negative or fractional count for "unknown"; only whole counts are used.
        const hits = toInt(hitsText);
        if (!current || lineNumber === undefined || hits === undefined || lineNumber < 1) {
          malformed += 1;
          break;
        }
        if (lineNumber > MAX_LINE_NUMBER) {
          malformed += 1;
          break;
        }
        current.lines.set(lineNumber, (current.lines.get(lineNumber) ?? 0) + hits);
        break;
      }
      case "FN": {
        // FN:<line>,<name> (lcov 2 also writes FN:<line>,<end line>,<name>)
        const parts = value.split(",");
        const lineNumber = toInt(parts[0]);
        const name = parts
          .slice(parts.length >= 3 && toInt(parts[1]) !== undefined ? 2 : 1)
          .join(",");
        if (!current || lineNumber === undefined || name === "") {
          malformed += 1;
          break;
        }
        const key = name;
        if (!current.functions.has(key)) {
          current.functions.set(key, { name, line: lineNumber, hits: 0 });
        }
        break;
      }
      case "FNDA": {
        // FNDA:<hits>,<name>
        const comma = value.indexOf(",");
        const hits = toInt(comma === -1 ? undefined : value.slice(0, comma));
        const name = comma === -1 ? "" : value.slice(comma + 1);
        if (!current || hits === undefined || name === "") {
          malformed += 1;
          break;
        }
        const fn = current.functions.get(name);
        if (fn) fn.hits += hits;
        break;
      }
      case "BRDA": {
        // BRDA:<line>,<block>,<branch>,<taken|->
        const [lineText, block, branch, taken] = value.split(",");
        const lineNumber = toInt(lineText);
        if (!current || lineNumber === undefined || block === undefined || branch === undefined) {
          malformed += 1;
          break;
        }
        const count = taken === "-" ? 0 : (toInt(taken) ?? Number.NaN);
        if (Number.isNaN(count)) {
          malformed += 1;
          break;
        }
        const key = `${lineNumber}:${block}:${branch}`;
        const earlier = current.branches.get(key);
        current.branches.set(key, {
          line: lineNumber,
          taken: (earlier?.taken ?? false) || count > 0,
        });
        break;
      }
      default:
        malformed += 1;
    }
  }
  close();

  if (files.size === 0) {
    throw new LcovError("invalid", "The file is not an LCOV coverage report.");
  }
  return { files: [...files.values()], malformedLines: malformed };
}
