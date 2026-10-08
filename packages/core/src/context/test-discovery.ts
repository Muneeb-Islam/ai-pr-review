import type { RepoRef } from "../github/client";
import { call, repoParams, treeSchema, type ContextClient } from "./github";
import {
  basenameOf,
  compilePatterns,
  extensionOf,
  VENDORED_PATTERNS,
  BUILD_OUTPUT_PATTERNS,
} from "./patterns";
import type { ChangedFile } from "./types";

const JS_TS_EXTENSIONS: ReadonlySet<string> = new Set([
  "js",
  "jsx",
  "ts",
  "tsx",
  "mjs",
  "cjs",
  "mts",
  "cts",
]);

const TEST_NAME = /\.(?:test|spec)\.[^./]+$/;
const TEST_DIRS = new Set(["test", "tests", "__tests__", "spec", "specs"]);
/** Directory names that hold source and are swapped for a test directory when mirroring a path. */
const SOURCE_DIRS = new Set(["src", "lib", "app"]);
/** Stems shared by many files; a same-stem match elsewhere in the package says nothing about them. */
const GENERIC_STEMS = new Set(["index", "main", "types", "utils", "helpers", "constants"]);
const MAX_LOOSE_MATCHES = 3;

const excluded = compilePatterns([...VENDORED_PATTERNS, ...BUILD_OUTPUT_PATTERNS]);

const dirOf = (path: string): string => path.slice(0, Math.max(0, path.lastIndexOf("/")));
const stemOf = (name: string): string => name.replace(/\.[^./]+$/, "");
const testStem = (name: string): string => stemOf(name.replace(TEST_NAME, ".x"));

/** True for a JS/TS test file: `*.test.*`, `*.spec.*`, or a JS/TS file under a test directory. */
export function isJsTsTestFile(path: string): boolean {
  if (!JS_TS_EXTENSIONS.has(extensionOf(path))) return false;
  if (TEST_NAME.test(basenameOf(path))) return true;
  return path
    .split("/")
    .slice(0, -1)
    .some((segment) => TEST_DIRS.has(segment));
}

/** True for a JS/TS file that is not a test: the files whose tests and coverage Phase 11 looks at. */
export function isJsTsSourceFile(path: string): boolean {
  return JS_TS_EXTENSIONS.has(extensionOf(path)) && !isJsTsTestFile(path);
}

/** Test files in the repository tree at a commit (JS/TS only, excluding vendored and build directories). */
export async function listTestFiles(options: {
  client: ContextClient;
  repo: RepoRef;
  /** A commit SHA; the git trees API accepts it as the tree to list. */
  sha: string;
  signal?: AbortSignal | undefined;
}): Promise<{ tests: string[]; packageRoots: string[]; truncated: boolean }> {
  const tree = await call(
    options.client,
    options.signal,
    "GET /repos/{owner}/{repo}/git/trees/{tree_sha}",
    { ...repoParams(options.repo), tree_sha: options.sha, recursive: "1" },
    treeSchema,
  );
  const blobs = tree.tree.filter((entry) => entry.type === "blob" && !excluded(entry.path));
  return {
    tests: blobs.map((e) => e.path).filter(isJsTsTestFile),
    packageRoots: blobs
      .filter((e) => basenameOf(e.path) === "package.json")
      .map((e) => dirOf(e.path)),
    truncated: tree.truncated === true,
  };
}

/** The directory of the nearest `package.json` at or above `path` ("" for the repository root). */
function packageRootOf(path: string, roots: ReadonlySet<string>): string {
  let dir = dirOf(path);
  for (;;) {
    if (roots.has(dir)) return dir;
    if (dir === "") return "";
    dir = dirOf(dir);
  }
}

const TEST_DIR_NAMES = ["test", "tests", "__tests__", "spec"] as const;

/** Directories where the tests of a file in `dir` usually live. */
function conventionalTestDirs(dir: string): Set<string> {
  const join = (...parts: string[]): string => parts.filter((p) => p !== "").join("/");
  const dirs = new Set<string>([dir, join(dir, "__tests__")]);
  for (const testDir of TEST_DIR_NAMES) dirs.add(join(testDir, dir)); // test/a/b for a/b
  const segments = dir === "" ? [] : dir.split("/");
  segments.forEach((segment, index) => {
    if (!SOURCE_DIRS.has(segment)) return;
    const head = segments.slice(0, index);
    const tail = segments.slice(index + 1);
    for (const testDir of TEST_DIR_NAMES) dirs.add(join(...head, testDir, ...tail)); // src/a -> test/a
    dirs.add(join(...head, segment, "__tests__", ...tail)); // src/__tests__/a
  });
  return dirs;
}

/**
 * Maps each changed JS/TS source file to the test files likely to cover it, by naming and path convention:
 * same name next to the file, in `__tests__/`, or in a mirrored `test/` tree (`src/a/b.ts` → `test/a/b.test.ts`).
 * A same-name test elsewhere in the same package counts too, unless the name is generic (`index`) or there are
 * many. Files with no match map to an empty list, which is what Phase 11 needs to report test gaps.
 */
export function mapSourceFilesToTests(
  changed: readonly Pick<ChangedFile, "path" | "status">[],
  repoTests: readonly string[],
  packageRoots: readonly string[] = [],
): Record<string, string[]> {
  const byStem = new Map<string, string[]>();
  for (const test of repoTests) {
    const stem = testStem(basenameOf(test));
    const list = byStem.get(stem);
    if (list) list.push(test);
    else byStem.set(stem, [test]);
  }
  const roots = new Set(packageRoots);
  const result: Record<string, string[]> = {};

  for (const file of changed) {
    if (file.status === "removed") continue;
    if (!JS_TS_EXTENSIONS.has(extensionOf(file.path)) || isJsTsTestFile(file.path)) continue;

    const stem = stemOf(basenameOf(file.path));
    const sameStem = byStem.get(stem) ?? [];
    const dirs = conventionalTestDirs(dirOf(file.path));
    const matches = new Set(sameStem.filter((test) => dirs.has(dirOf(test))));

    if (matches.size === 0 && !GENERIC_STEMS.has(stem)) {
      const root = packageRootOf(file.path, roots);
      const nearby = sameStem.filter((test) => packageRootOf(test, roots) === root);
      if (nearby.length > 0 && nearby.length <= MAX_LOOSE_MATCHES)
        nearby.forEach((t) => matches.add(t));
    }
    result[file.path] = [...matches].sort();
  }
  return result;
}
