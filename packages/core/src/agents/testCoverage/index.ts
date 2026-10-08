import type { Finding, Severity } from "@ai-pr-review/shared";
import { isJsTsTestFile } from "../../context/test-discovery";
import type { ChangedFile, ReviewContext } from "../../context/types";
import { TEST_COVERAGE_PROMPT } from "../../prompts/testCoverage.v1";
import { measureCoverage, selectCoverageFiles } from "../../test-coverage";
import { createLlmAgent, type PreparedRun } from "../structured";
import type { AgentDeps, AgentTask } from "../types";
import { coverageSection, relatedTestsSection } from "./sections";

/** Most suggestions one run carries. More is noise; the prompt asks for eight at most. */
export const MAX_TEST_SUGGESTIONS = 8;

/**
 * A missing test is advice. The model is told the scale stops at medium; this keeps that true when it is not, so a
 * test suggestion can never reach a severity that an enforcement mode (Phase 13) would block a merge for.
 */
const SEVERITY_CEILING: Severity = "medium";
const RANK: Record<Severity, number> = { critical: 4, high: 3, medium: 2, low: 1, info: 0 };

/**
 * What the Test Coverage agent reads: the pull request's JS/TS files that were not deleted, source and tests alike,
 * because a test the pull request adds is the evidence that a new branch is covered.
 */
export function selectTestCoverageFiles(context: ReviewContext): ChangedFile[] {
  return context.files.filter(
    (file) => file.status !== "removed" && Boolean(file.patch) && /\.[cm]?[jt]sx?$/.test(file.path),
  );
}

export function refineSuggestions(findings: Finding[]): Finding[] {
  return findings
    .filter(
      (finding) =>
        // FR-24: without scenario, setup and assertion there is no suggestion to give.
        (finding.suggestedTest ?? "").trim().length >= 20 &&
        // A gap in a test file is a review remark, not a missing test.
        !(finding.filePath !== undefined && isJsTsTestFile(finding.filePath)),
    )
    .map((finding) =>
      RANK[finding.severity] > RANK[SEVERITY_CEILING]
        ? { ...finding, severity: SEVERITY_CEILING }
        : finding,
    )
    .slice(0, MAX_TEST_SUGGESTIONS);
}

async function prepare(task: AgentTask, deps: AgentDeps): Promise<PreparedRun> {
  const { context, config, signal } = task;
  const sources = selectCoverageFiles(task.files);

  const coverage = await measureCoverage({
    client: deps.github?.client,
    repo: deps.github?.repo,
    headSha: context.pr.headSha,
    files: task.files,
    artifactName: config.coverage.artifact_name,
    lcovPath: config.coverage.lcov_path,
    signal,
    logger: deps.logger,
  });

  // A missing permission is something the owner can fix, so it is a warning; the other reasons are ordinary.
  const warnings =
    coverage.reasonCode === "actions_denied" && coverage.reason
      ? [`Test Coverage: ${coverage.reason}`]
      : [];

  // Only tests and docs changed: there is nothing to suggest tests for, and no model call is needed.
  if (sources.length === 0) return { coverage, warnings, skipModel: true };

  const related = await relatedTestsSection(
    context,
    sources,
    new Set(task.files.map((file) => file.path)),
    deps,
    signal,
    config.secret_paths,
  );
  return { coverage, warnings, sections: [related, coverageSection(coverage)] };
}

/**
 * Test Coverage agent (FR-22 to FR-25, design §10). Two parts that never mix: the measurement, which comes from the
 * LCOV report CI uploaded and is reported as such, and the suggestions, which come from the model reading the diff
 * next to the tests that exist and are always labelled as suggestions (FR-25). Without a report the agent says so
 * and still suggests tests (FR-23).
 */
export const testCoverageAgent = createLlmAgent({
  id: "test_coverage",
  label: "Test Coverage",
  prompt: TEST_COVERAGE_PROMPT,
  categories: ["test_gap"],
  selectFiles: selectTestCoverageFiles,
  prepare,
  refine: refineSuggestions,
});
