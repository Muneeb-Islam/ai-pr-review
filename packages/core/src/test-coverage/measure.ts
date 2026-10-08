import type { CoverageReason, CoverageSummary, Logger } from "@ai-pr-review/shared";
import type { ContextClient } from "../context/github";
import type { ChangedFile } from "../context/types";
import { isJsTsSourceFile } from "../context/test-discovery";
import type { RepoRef } from "../github/client";
import { describeUnavailable, fetchCoverageArtifact } from "./artifact";
import { computeChangedCoverage } from "./compute";
import { LcovError, parseLcov } from "./lcov";
import type { ZipLimits } from "./zip";

/** The changed files coverage applies to: JS/TS source that is not deleted and has added lines. */
export function selectCoverageFiles(files: readonly ChangedFile[]): ChangedFile[] {
  return files.filter(
    (file) =>
      file.status !== "removed" && file.addedLines.length > 0 && isJsTsSourceFile(file.path),
  );
}

export interface MeasureCoverageOptions {
  client: ContextClient | undefined;
  repo: RepoRef | undefined;
  headSha: string;
  files: readonly ChangedFile[];
  artifactName: string;
  lcovPath: string;
  signal?: AbortSignal | undefined;
  limits?: ZipLimits;
  logger?: Logger | undefined;
}

/**
 * Measures the coverage of the changed lines from the LCOV artifact CI uploaded for the head commit (FR-22), or
 * says plainly why it cannot (FR-23). Never throws except for an abort: a missing, expired, oversized or broken
 * report is `not_available` with the reason, and the review carries on with code-based analysis.
 */
export async function measureCoverage(options: MeasureCoverageOptions): Promise<CoverageSummary> {
  const settings = { artifactName: options.artifactName, lcovPath: options.lcovPath };
  const notAvailable = (code: CoverageReason, reason?: string): CoverageSummary => ({
    status: "not_available",
    reason: reason ?? describeUnavailable(code, settings),
    reasonCode: code,
    observations: [],
  });

  const sources = selectCoverageFiles(options.files);
  if (sources.length === 0) {
    return {
      status: "skipped",
      reason: describeUnavailable("no_source_files", settings),
      reasonCode: "no_source_files",
      observations: [],
    };
  }
  if (!options.client || !options.repo) return notAvailable("no_client");

  const fetched = await fetchCoverageArtifact({
    client: options.client,
    repo: options.repo,
    headSha: options.headSha,
    artifactName: options.artifactName,
    lcovPath: options.lcovPath,
    signal: options.signal,
    ...(options.limits ? { limits: options.limits } : {}),
  });
  if (!fetched.ok) {
    options.logger?.info("Coverage not available", { reason: fetched.code });
    return notAvailable(fetched.code, fetched.message);
  }

  let report;
  try {
    report = parseLcov(fetched.lcov);
  } catch (err) {
    if (err instanceof LcovError) {
      const code: CoverageReason = err.code === "empty" ? "lcov_empty" : "lcov_invalid";
      options.logger?.info("Coverage report unusable", { reason: code });
      return notAvailable(code);
    }
    throw err;
  }

  const { summary, pathRule, reportFiles } = computeChangedCoverage(sources, report);
  options.logger?.info("Coverage measured", {
    reportFiles,
    changedFiles: sources.length,
    matched: summary.files?.filter((f) => f.status === "measured").length ?? 0,
    // Only the kind of rule: its prefix is a path from the CI runner.
    pathRule: pathRule.split(":")[0],
    malformedLines: report.malformedLines,
    ...(summary.changedLineCoverage !== undefined
      ? { changedLineCoverage: Math.round(summary.changedLineCoverage * 1000) / 10 }
      : {}),
  });
  return { ...summary, artifact: fetched.artifact };
}
