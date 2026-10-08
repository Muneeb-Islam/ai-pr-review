import {
  BINARY_EXTENSIONS,
  BUILD_OUTPUT_PATTERNS,
  compilePatterns,
  extensionOf,
  GENERATED_PATH_PATTERNS,
  LOCKFILE_PATTERNS,
  SECRET_PATH_PATTERNS,
  VENDORED_PATTERNS,
  type PathMatcher,
} from "./patterns";

/** Why a file never reaches a model. The text is shown to users in the summary. */
export const SKIP_REASONS = {
  secret: "matches a secret-file pattern",
  binary: "binary or non-text file",
  lockfile: "lockfile",
  vendored: "vendored dependency",
  buildOutput: "build output",
  generated: "generated file",
  ignored: "matches the ignore setting",
  noPatch: "diff too large or unavailable from GitHub",
  noChanges: "no textual changes",
} as const;

export type ExclusionReason = (typeof SKIP_REASONS)[keyof typeof SKIP_REASONS];

export interface PathClassifier {
  /** The reason this path is excluded by name alone, or `undefined` if it may be reviewed. */
  excludedBy(path: string): ExclusionReason | undefined;
  isSecretPath(path: string): boolean;
  isTestPath(path: string): boolean;
  /** Review priority when the PR is too large: lower comes first. Source, then tests, then config, then docs. */
  priority(path: string): number;
}

const SOURCE_EXTENSIONS: ReadonlySet<string> = new Set([
  "ts",
  "tsx",
  "mts",
  "cts",
  "js",
  "jsx",
  "mjs",
  "cjs",
  "vue",
  "svelte",
  "py",
  "go",
  "rs",
  "java",
  "kt",
  "rb",
  "php",
  "cs",
  "swift",
  "c",
  "h",
  "cc",
  "cpp",
  "hpp",
  "sql",
  "sh",
  "css",
  "scss",
  "html",
]);

const DOC_EXTENSIONS: ReadonlySet<string> = new Set(["md", "mdx", "txt", "rst", "adoc"]);

const TEST_PATH = compilePatterns([
  "**/*.test.*",
  "**/*.spec.*",
  "**/__tests__/**",
  "**/test/**",
  "**/tests/**",
  "**/__mocks__/**",
]);

export const PRIORITY = { source: 0, test: 1, config: 2, docs: 3 } as const;

/**
 * Builds the path rules for one run: the built-in categories plus the repository's `ignore` and
 * `secret_paths` settings. Built-in secret patterns cannot be turned off by configuration.
 */
export function createPathClassifier(options: {
  ignore: readonly string[];
  secretPaths: readonly string[];
}): PathClassifier {
  const secret = compilePatterns([...SECRET_PATH_PATTERNS, ...options.secretPaths]);
  const lockfile = compilePatterns(LOCKFILE_PATTERNS);
  const vendored = compilePatterns(VENDORED_PATTERNS);
  const buildOutput = compilePatterns(BUILD_OUTPUT_PATTERNS);
  const generated = compilePatterns(GENERATED_PATH_PATTERNS);
  const ignored = compilePatterns(options.ignore);

  // Order matters: a secret file is reported as such even if it is also ignored.
  const rules: Array<[PathMatcher, ExclusionReason]> = [
    [secret, SKIP_REASONS.secret],
    [(p) => BINARY_EXTENSIONS.has(extensionOf(p)), SKIP_REASONS.binary],
    [lockfile, SKIP_REASONS.lockfile],
    [vendored, SKIP_REASONS.vendored],
    [buildOutput, SKIP_REASONS.buildOutput],
    [generated, SKIP_REASONS.generated],
    [ignored, SKIP_REASONS.ignored],
  ];

  return {
    excludedBy(path) {
      for (const [matches, reason] of rules) if (matches(path)) return reason;
      return undefined;
    },
    isSecretPath: secret,
    isTestPath: TEST_PATH,
    priority(path) {
      if (TEST_PATH(path)) return PRIORITY.test;
      const ext = extensionOf(path);
      if (DOC_EXTENSIONS.has(ext) || /^docs?\//i.test(path)) return PRIORITY.docs;
      if (SOURCE_EXTENSIONS.has(ext)) return PRIORITY.source;
      // Dotfiles, JSON/YAML/TOML, Dockerfiles and anything unrecognised.
      return PRIORITY.config;
    },
  };
}

const GENERATED_MARKER =
  /@generated|\bDO NOT EDIT\b|\bCode generated\b|\bauto-?generated\b|\bThis file (?:is|was) (?:auto-?)?generated\b/i;

/** Minified bundles have very long lines; hand-written code rarely does. */
const MINIFIED_LINE_LENGTH = 2000;
const MINIFIABLE_EXTENSIONS: ReadonlySet<string> = new Set(["js", "mjs", "cjs", "css"]);

/**
 * Content-based check for generated files, run on a patch: a "generated" banner in the first added lines of a
 * file's first hunk, or minified code. Path-based rules cannot see these.
 */
export function looksGenerated(path: string, patch: string): boolean {
  const lines = patch.split("\n");
  const first = lines[0] ?? "";
  // A banner is at the top of the file, so only a first hunk that starts at line 1 can contain it.
  if (/^@@ -\d+(?:,\d+)? \+1[ ,]/.test(first)) {
    const head = lines
      .slice(1, 12)
      .filter((l) => l.startsWith("+"))
      .join("\n");
    if (GENERATED_MARKER.test(head)) return true;
  }
  if (MINIFIABLE_EXTENSIONS.has(extensionOf(path))) {
    return lines.some((l) => l.length > MINIFIED_LINE_LENGTH);
  }
  return false;
}
