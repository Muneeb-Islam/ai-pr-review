import type { CoverageFile, CoverageSummary, LineRange } from "@ai-pr-review/shared";
import { createPathClassifier } from "../../context/classify";
import { call, contentSchema, decodeContent, repoParams } from "../../context/github";
import { redactSecrets } from "../../context/redact";
import type { ChangedFile, ReviewContext } from "../../context/types";
import type { AgentDeps } from "../types";

// What the Test Coverage agent shows the model besides the diff: which tests exist for the changed code, and, when
// CI uploaded a report, which changed lines never ran. Both go inside the untrusted block of the prompt.

const MAX_TEST_FILES = 6;
const MAX_OUTLINE_LINES = 60;
const MAX_OUTLINE_LINE_CHARS = 160;
const MAX_FALLBACK_CHARS = 1_500;
const MAX_TEST_BYTES = 200 * 1024;
const MAX_COVERAGE_LINES = 40;

const TEST_DECLARATION = /^\s*(?:describe|it|test|context|suite)(?:\.\w+)*\s*\(/;

/** Test names and group names: enough to see which behaviour a file tests, at a fraction of its size. */
export function outlineTestFile(text: string): string {
  const lines = text
    .split("\n")
    .filter((line) => TEST_DECLARATION.test(line))
    .slice(0, MAX_OUTLINE_LINES)
    .map((line) => line.replace(/\s+$/, "").slice(0, MAX_OUTLINE_LINE_CHARS));
  if (lines.length > 0) return lines.join("\n");
  // No recognisable declarations (another framework, or a helper file): a short head is better than nothing.
  return text.length > MAX_FALLBACK_CHARS
    ? `${text.slice(0, MAX_FALLBACK_CHARS)}\n[truncated]`
    : text;
}

const rangeText = (ranges: readonly LineRange[]): string =>
  ranges.map((r) => (r.start === r.end ? `${r.start}` : `${r.start}-${r.end}`)).join(", ");

function coverageFileLine(file: CoverageFile): string {
  if (file.status === "not_in_report") {
    return `- ${file.path}: not in the report, so its coverage is unknown`;
  }
  if (file.totalLines === 0) {
    return `- ${file.path}: no executable changed lines`;
  }
  const parts = [`${file.coveredLines} of ${file.totalLines} executable changed lines ran`];
  if (file.uncovered.length > 0) parts.push(`never ran: lines ${rangeText(file.uncovered)}`);
  if (file.uncoveredFunctions?.length) {
    parts.push(`functions that never ran: ${file.uncoveredFunctions.join(", ")}`);
  }
  return `- ${file.path}: ${parts.join("; ")}`;
}

/** The measured-coverage section: facts for the model to aim at, not for it to repeat. */
export function coverageSection(coverage: CoverageSummary): { title: string; body: string } {
  const title = "Measured coverage of the changed lines";
  if (coverage.status !== "measured") {
    return {
      title,
      body: `Not available: ${coverage.reason ?? "no report"} Judge from the diff and the tests only.`,
    };
  }
  const files = coverage.files ?? [];
  const lines = files.slice(0, MAX_COVERAGE_LINES).map(coverageFileLine);
  if (files.length > MAX_COVERAGE_LINES) {
    lines.push(`- ...and ${files.length - MAX_COVERAGE_LINES} more files`);
  }
  return { title, body: ["From the report CI uploaded for this commit:", ...lines].join("\n") };
}

/**
 * The related-tests section. Test files this pull request changes are in the diff already; the others are read at
 * the head commit and reduced to an outline. Files whose names look secret are never read, and a read that fails
 * for any reason other than an abort is skipped: the section then just lists the name.
 */
export async function relatedTestsSection(
  context: ReviewContext,
  sources: readonly ChangedFile[],
  inDiff: ReadonlySet<string>,
  deps: Pick<AgentDeps, "github">,
  signal: AbortSignal | undefined,
  secretPaths: readonly string[],
): Promise<{ title: string; body: string }> {
  const title = "Related tests";
  if (Object.keys(context.testFiles).length === 0) {
    return { title, body: "Test discovery was not available, so related tests are unknown." };
  }
  const classifier = createPathClassifier({ ignore: [], secretPaths });

  const listing = sources.map((file) => {
    const tests = context.testFiles[file.path] ?? [];
    return tests.length === 0
      ? `- ${file.path}: no related test file found by naming convention`
      : `- ${file.path}: ${tests.join(", ")}`;
  });

  const toRead: string[] = [];
  for (const file of sources) {
    for (const test of context.testFiles[file.path] ?? []) {
      if (inDiff.has(test) || toRead.includes(test) || classifier.isSecretPath(test)) continue;
      toRead.push(test);
    }
  }

  const outlines: string[] = [];
  if (deps.github) {
    for (const path of toRead.slice(0, MAX_TEST_FILES)) {
      signal?.throwIfAborted();
      try {
        const content = await call(
          deps.github.client,
          signal,
          "GET /repos/{owner}/{repo}/contents/{path}",
          { ...repoParams(deps.github.repo), path, ref: context.pr.headSha },
          contentSchema,
        );
        if ((content.size ?? 0) > MAX_TEST_BYTES) continue;
        const text = decodeContent(content);
        if (text === undefined) continue;
        outlines.push(`### ${path}\n${redactSecrets(outlineTestFile(text)).text}`);
      } catch (err) {
        if (signal?.aborted) throw err;
        // A test file we cannot read is left out of the outlines; its name is still listed above.
      }
    }
  }

  const body = [
    ...(listing.length > 0 ? listing : ["(no changed source files)"]),
    ...(outlines.length > 0
      ? ["", "Outlines of the existing test files (names of their tests):", ...outlines]
      : []),
    ...(inDiff.size > 0 ? ["", "Test files changed by this pull request appear in the diff."] : []),
  ].join("\n");
  return { title, body };
}
