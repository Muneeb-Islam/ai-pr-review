import type { CoverageReason } from "@ai-pr-review/shared";
import { z } from "zod";
import type { RepoRef } from "../github/client";
import { call, repoParams, type ContextClient } from "../context/github";
import { DEFAULT_ZIP_LIMITS, readZipEntry, ZipError, type ZipLimits } from "./zip";

// Finds the coverage report CI uploaded for a commit and reads it (FR-22, decision 19): the workflow runs for the
// head SHA, their artifacts, the one with the configured name, its zip, the LCOV file inside. Everything goes
// through the GitHub API with the installation token (`actions: read`); nothing is checked out or executed, and the
// archive is only ever held in memory.

const MAX_RUNS_CHECKED = 10;
const PER_PAGE = 100;
/** Statuses of a workflow run that has not finished. */
const ACTIVE_RUN_STATUSES = new Set(["queued", "in_progress", "waiting", "requested", "pending"]);

const runsSchema = z.object({
  workflow_runs: z.array(
    z.object({
      id: z.number(),
      status: z.string().nullable().optional(),
      created_at: z.string().optional(),
    }),
  ),
});

const artifactsSchema = z.object({
  artifacts: z.array(
    z.object({
      id: z.number(),
      name: z.string(),
      size_in_bytes: z.number().optional(),
      expired: z.boolean().optional(),
      created_at: z.string().nullable().optional(),
    }),
  ),
});

export interface CoverageFetchOptions {
  client: ContextClient;
  repo: RepoRef;
  headSha: string;
  artifactName: string;
  lcovPath: string;
  signal?: AbortSignal | undefined;
  limits?: ZipLimits;
}

export type CoverageFetchResult =
  | {
      ok: true;
      /** The LCOV text. */
      lcov: string;
      artifact: { name: string; runId: number };
    }
  | { ok: false; code: CoverageReason; message: string };

/** One fixed sentence per reason, shown to users. `name` and `path` are the repository's own coverage settings. */
export function describeUnavailable(
  code: CoverageReason,
  settings: { artifactName: string; lcovPath: string } = {
    artifactName: "coverage",
    lcovPath: "lcov.info",
  },
): string {
  switch (code) {
    case "actions_denied":
      return "The GitHub App is not allowed to read Actions artifacts. Grant it the Actions: read permission to measure coverage.";
    case "no_runs":
      return "No CI workflow run was found for this commit.";
    case "ci_running":
      return "CI was still running when the review started, so no coverage report was ready.";
    case "no_artifact":
      return `No CI run for this commit uploaded an artifact named "${settings.artifactName}". Upload the LCOV report from CI with actions/upload-artifact.`;
    case "artifact_expired":
      return `The coverage artifact "${settings.artifactName}" has expired.`;
    case "artifact_too_large":
      return "The coverage artifact is too large to read.";
    case "artifact_invalid":
      return "The coverage artifact could not be read safely.";
    case "lcov_missing":
      return `The coverage artifact has no file named "${settings.lcovPath}". Set coverage.lcov_path to where the report is.`;
    case "lcov_invalid":
      return "The coverage file is not a valid LCOV report.";
    case "lcov_empty":
      return "The coverage report is empty.";
    case "github_error":
      return "GitHub could not be reached to look for a coverage report.";
    case "no_client":
      return "No GitHub access was available to look for a coverage report.";
    case "no_source_files":
      return "The pull request changes no source file that coverage applies to.";
  }
}

const statusOf = (err: unknown): number | undefined =>
  typeof err === "object" && err !== null && "status" in err && typeof err.status === "number"
    ? err.status
    : undefined;

/** GitHub answers a missing permission with 403 (or 404 for a repository the token cannot see). */
const isDenied = (err: unknown): boolean => statusOf(err) === 403 || statusOf(err) === 404;

/** The body of a downloaded artifact, whatever shape the HTTP client delivered it in. */
function asBytes(data: unknown): Uint8Array | undefined {
  if (data instanceof Uint8Array) return data;
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  return undefined;
}

/**
 * Looks for the coverage artifact of the head commit and returns the LCOV text, or says why there is none. An
 * abort propagates (the run was cancelled); every other failure becomes a reason, never an exception, because a
 * missing report must not fail a review.
 */
export async function fetchCoverageArtifact(
  options: CoverageFetchOptions,
): Promise<CoverageFetchResult> {
  const { client, repo, signal } = options;
  const limits = options.limits ?? DEFAULT_ZIP_LIMITS;
  const settings = { artifactName: options.artifactName, lcovPath: options.lcovPath };
  const unavailable = (code: CoverageReason): CoverageFetchResult => ({
    ok: false,
    code,
    message: describeUnavailable(code, settings),
  });

  try {
    // ---- workflow runs for the commit, newest first
    const runs = (
      await call(
        client,
        signal,
        "GET /repos/{owner}/{repo}/actions/runs",
        { ...repoParams(repo), head_sha: options.headSha, per_page: PER_PAGE },
        runsSchema,
      )
    ).workflow_runs
      .slice()
      .sort(
        (a, b) => Date.parse(b.created_at ?? "") - Date.parse(a.created_at ?? "") || b.id - a.id,
      )
      .slice(0, MAX_RUNS_CHECKED);
    if (runs.length === 0) return unavailable("no_runs");

    // ---- the artifact: the newest one with the configured name that has not expired
    let found: { id: number; runId: number; size: number } | undefined;
    let sawExpired = false;
    for (const run of runs) {
      const { artifacts } = await call(
        client,
        signal,
        "GET /repos/{owner}/{repo}/actions/runs/{run_id}/artifacts",
        { ...repoParams(repo), run_id: run.id, name: options.artifactName, per_page: PER_PAGE },
        artifactsSchema,
      );
      const matching = artifacts
        .filter((a) => a.name === options.artifactName)
        .sort(
          (a, b) => Date.parse(b.created_at ?? "") - Date.parse(a.created_at ?? "") || b.id - a.id,
        );
      const usable = matching.find((a) => a.expired !== true);
      if (usable) {
        found = { id: usable.id, runId: run.id, size: usable.size_in_bytes ?? 0 };
        break;
      }
      if (matching.length > 0) sawExpired = true;
    }
    if (!found) {
      if (runs.some((run) => ACTIVE_RUN_STATUSES.has(run.status ?? "")))
        return unavailable("ci_running");
      return unavailable(sawExpired ? "artifact_expired" : "no_artifact");
    }
    if (found.size > limits.maxArchiveBytes) return unavailable("artifact_too_large");

    // ---- download and unpack in memory
    signal?.throwIfAborted();
    const response = await client.request(
      "GET /repos/{owner}/{repo}/actions/artifacts/{artifact_id}/{archive_format}",
      {
        ...repoParams(repo),
        artifact_id: found.id,
        archive_format: "zip",
        ...(signal ? { request: { signal } } : {}),
      },
    );
    const bytes = asBytes(response.data);
    if (!bytes) return unavailable("artifact_invalid");
    if (bytes.byteLength > limits.maxArchiveBytes) return unavailable("artifact_too_large");

    let entry;
    try {
      entry = readZipEntry(bytes, { path: options.lcovPath, fallbackToBasename: true }, limits);
    } catch (err) {
      if (err instanceof ZipError) {
        return unavailable(err.code === "too_large" ? "artifact_too_large" : "artifact_invalid");
      }
      throw err;
    }
    if (!entry) return unavailable("lcov_missing");
    return {
      ok: true,
      lcov: entry.data.toString("utf8"),
      artifact: { name: options.artifactName, runId: found.runId },
    };
  } catch (err) {
    if (signal?.aborted) throw err;
    return unavailable(isDenied(err) ? "actions_denied" : "github_error");
  }
}
