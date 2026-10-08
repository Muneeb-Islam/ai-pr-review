import type { LcovFile } from "./lcov";

// Coverage tools write paths in whatever form suits them: absolute on the CI runner (`/home/runner/work/app/app/
// src/a.ts`), Windows style (`D:\a\app\app\src\a.ts`), relative to a package inside a monorepo (`src/a.ts` for
// `packages/web/src/a.ts`), or with a `./` or `file://` prefix. This module maps them to repository-relative paths.
// It never guesses: a file that cannot be matched unambiguously is reported as missing from the report, because a
// wrong match would show another file's coverage and a missing one only shows a gap.

/** Forward slashes, no `file://`, no `./`, no doubled slashes; a drive letter is kept so absolute paths are recognisable. */
export function normalizeReportPath(raw: string): string {
  let path = raw.trim().replaceAll("\\", "/");
  path = path.replace(/^file:\/+/i, "/");
  if (/^\/[A-Za-z]:\//.test(path)) path = path.slice(1); // file:///C:/x
  path = path.replace(/\/{2,}/g, "/");
  while (path.startsWith("./")) path = path.slice(2);
  // Resolve `a/../b` and `a/./b` so a path that climbs cannot match by accident.
  const absolute = path.startsWith("/") || /^[A-Za-z]:\//.test(path);
  const segments: string[] = [];
  for (const segment of path.split("/")) {
    if (segment === "" || segment === ".") continue;
    if (segment === "..") {
      if (segments.length > 0 && segments[segments.length - 1] !== "..") segments.pop();
      else if (!absolute) segments.push("..");
      continue;
    }
    segments.push(segment);
  }
  const joined = segments.join("/");
  if (path.startsWith("/")) return `/${joined}`;
  return joined;
}

/** A path that starts at a filesystem root (`/…` or `C:/…`) rather than inside the repository. */
export const isAbsoluteReportPath = (path: string): boolean =>
  path.startsWith("/") || /^[A-Za-z]:\//.test(path);

/** How report paths relate to repository paths: the report's path is `strip + repoPath` or `repoPath` minus `add`. */
interface Transform {
  kind: "same" | "strip" | "add";
  /** The text removed from the front of a report path (`strip`) or put in front of it (`add`). */
  prefix: string;
}

const same: Transform = { kind: "same", prefix: "" };

function apply(transform: Transform, reportPath: string): string | undefined {
  switch (transform.kind) {
    case "same":
      return reportPath;
    case "strip":
      return reportPath.startsWith(transform.prefix)
        ? reportPath.slice(transform.prefix.length)
        : undefined;
    case "add":
      return `${transform.prefix}${reportPath}`;
  }
}

const keyOf = (t: Transform): string => `${t.kind}:${t.prefix}`;

export interface PathMatch {
  /** Changed repository path → the report's record for it. */
  matched: Map<string, LcovFile>;
  /** Changed paths with no unambiguous record. */
  unmatched: string[];
  /** The rule that was applied, for logs: `same`, `strip:/home/runner/work/app/app/`, `add:packages/web/`. */
  rule: string;
}

/**
 * Matches the report's files to the pull request's changed files. One rule is chosen for the whole report (all
 * its paths are written the same way): leave the paths alone, strip a common absolute prefix, or add a package
 * prefix. The rule with the most matching changed files wins; a changed file that matches two records, or a
 * record claimed by two changed files, is left unmatched.
 */
export function matchReportFiles(
  changedPaths: readonly string[],
  reportFiles: readonly LcovFile[],
): PathMatch {
  const reportByPath = new Map<string, LcovFile>();
  for (const file of reportFiles) {
    const path = normalizeReportPath(file.path);
    if (path === "") continue;
    const earlier = reportByPath.get(path);
    if (earlier) {
      // Two records with one normalised name (a `\` and a `/` spelling): merge them.
      for (const [line, hits] of file.lines) {
        earlier.lines.set(line, (earlier.lines.get(line) ?? 0) + hits);
      }
      earlier.functions.push(...file.functions);
      earlier.branches.push(...file.branches);
    } else {
      reportByPath.set(path, {
        path,
        lines: new Map(file.lines),
        functions: [...file.functions],
        branches: [...file.branches],
      });
    }
  }

  // Count which rule explains the most changed files.
  const votes = new Map<string, { transform: Transform; count: number }>();
  const vote = (transform: Transform) => {
    const key = keyOf(transform);
    const entry = votes.get(key);
    if (entry) entry.count += 1;
    else votes.set(key, { transform, count: 1 });
  };
  for (const changed of changedPaths) {
    for (const reportPath of reportByPath.keys()) {
      if (reportPath === changed) vote(same);
      else if (reportPath.endsWith(`/${changed}`)) {
        vote({ kind: "strip", prefix: reportPath.slice(0, reportPath.length - changed.length) });
      } else if (changed.endsWith(`/${reportPath}`) && !isAbsoluteReportPath(reportPath)) {
        vote({ kind: "add", prefix: changed.slice(0, changed.length - reportPath.length) });
      }
    }
  }
  const ranked = [...votes.values()].sort(
    (a, b) =>
      b.count - a.count ||
      // Equal support: prefer leaving paths alone, then the shorter (less presumptuous) prefix.
      (a.transform.kind === "same" ? -1 : b.transform.kind === "same" ? 1 : 0) ||
      a.transform.prefix.length - b.transform.prefix.length,
  );
  const [best, second] = ranked;
  // Two different package prefixes explain the report equally well (the same file name in two packages): the
  // report cannot be attributed, so nothing is matched by prefix.
  const ambiguous =
    best !== undefined &&
    second !== undefined &&
    best.count === second.count &&
    best.transform.kind !== "same" &&
    second.transform.kind !== "same";
  const transform = ambiguous ? same : (best?.transform ?? same);

  // Apply the rule to every report path, then look each changed file up.
  const byRepoPath = new Map<string, LcovFile[]>();
  for (const [reportPath, file] of reportByPath) {
    const repoPath = apply(transform, reportPath);
    if (repoPath === undefined) continue;
    const list = byRepoPath.get(repoPath);
    if (list) list.push(file);
    else byRepoPath.set(repoPath, [file]);
  }

  const matched = new Map<string, LcovFile>();
  const unmatched: string[] = [];
  for (const changed of changedPaths) {
    const candidates = byRepoPath.get(changed);
    if (candidates?.length === 1) matched.set(changed, candidates[0] as LcovFile);
    else unmatched.push(changed);
  }
  return {
    matched,
    unmatched,
    rule: transform.kind === "same" ? "same" : `${transform.kind}:${transform.prefix}`,
  };
}
