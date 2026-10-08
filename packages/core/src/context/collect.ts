import { applyForkLimits, type Logger, type RawConfig } from "@ai-pr-review/shared";
import type { RepoRef } from "../github/client";
import { createPathClassifier, looksGenerated, SKIP_REASONS } from "./classify";
import { addedLineRanges, DiffIndex, parsePatch } from "./diff";
import {
  call,
  fileSchema,
  listPages,
  MAX_FILE_PAGES,
  pullSchema,
  repoParams,
  UnexpectedResponseError,
  type ContextClient,
} from "./github";
import { collectPrior } from "./prior";
import { redactPatch, redactSecrets } from "./redact";
import { loadEffectiveConfig } from "./repo-config";
import { applySizePolicy, type SizeCandidate } from "./size";
import { listTestFiles, mapSourceFilesToTests } from "./test-discovery";
import type {
  ChangedFile,
  ChangedFileStatus,
  PriorState,
  ReviewContext,
  SkippedFile,
} from "./types";

/** The PR description is context, not content to review; cap it. */
export const PR_BODY_MAX_CHARACTERS = 6_000;
export const PR_TITLE_MAX_CHARACTERS = 300;

export interface CollectContextOptions {
  /** An Octokit instance authenticated as the installation (`GitHubClient`), or a fake in tests. */
  octokit: ContextClient;
  repo: RepoRef;
  prNumber: number;
  /** Installation defaults merged with the repository's dashboard settings (config keys, not yet validated). */
  config: RawConfig;
  signal?: AbortSignal;
  logger?: Logger;
  /** The App's bot login (`<slug>[bot]`), used to recognise its own earlier comments. */
  appLogin?: string;
}

const STATUS_MAP: Record<string, ChangedFileStatus> = {
  added: "added",
  copied: "added",
  modified: "modified",
  changed: "modified",
  removed: "removed",
  renamed: "renamed",
};

function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max)}\n[truncated]`;
}

/**
 * Collects the PR context a review needs through the GitHub API and removes anything unsafe, irrelevant or
 * oversized before a model can see it (design §6, §10).
 *
 * No checkout, no filesystem, no database, and no access to the environment: the only inputs are the parameters
 * and the GitHub responses, and the result holds no token. Order of work:
 * PR → repo config from the base SHA → changed files (paginated) → exclusions → redaction → size policy →
 * prior App comments → test discovery.
 */
export async function collectContext(options: CollectContextOptions): Promise<ReviewContext> {
  const { octokit: client, repo, prNumber, signal, logger } = options;
  const warnings: string[] = [];
  const base = repoParams(repo);

  // ---- pull request
  const pull = await call(
    client,
    signal,
    "GET /repos/{owner}/{repo}/pulls/{pull_number}",
    { ...base, pull_number: prNumber },
    pullSchema,
  );
  const baseSha = pull.base.sha;
  const headSha = pull.head.sha;

  // ---- effective configuration (from the base branch, never the PR head)
  const effective = await loadEffectiveConfig({
    client,
    repo,
    baseSha,
    dashboard: options.config,
    signal,
  });
  // A pull request from a fork is written by a stranger: when fork review is on, it is reviewed under stricter
  // per-PR limits than the repository's own (AC-23). The caps only lower limits, whatever the settings say.
  const isFork = pull.head.repo === null || pull.head.repo.full_name !== pull.base.repo.full_name;
  const config = isFork ? applyForkLimits(effective.config) : effective.config;
  warnings.push(...effective.warnings);
  if (isFork)
    warnings.push("This pull request comes from a fork, so it was reviewed under stricter limits.");

  // ---- changed files
  const listed = await listPages(
    client,
    signal,
    "GET /repos/{owner}/{repo}/pulls/{pull_number}/files",
    { ...base, pull_number: prNumber },
    fileSchema,
    MAX_FILE_PAGES,
  );
  const reported = pull.changed_files ?? listed.items.length;
  if (listed.truncated || reported > listed.items.length) {
    warnings.push(
      `GitHub lists ${listed.items.length} of ${reported} changed files; the rest were not reviewed.`,
    );
  }

  // ---- exclusions, redaction
  const classifier = createPathClassifier({
    ignore: config.ignore,
    secretPaths: config.secret_paths,
  });
  let redactions = 0;
  const skipped: SkippedFile[] = [];
  const candidates: SizeCandidate[] = [];

  for (const item of listed.items) {
    const status = STATUS_MAP[item.status];
    const path = item.filename;
    const skip = (reason: string): void => {
      skipped.push({ path, reason });
    };

    if (status === undefined) {
      skip(SKIP_REASONS.noChanges); // "unchanged"
      continue;
    }
    // A renamed file's old name counts too: `.env` renamed to `config.txt` is still a secret file.
    const excluded =
      classifier.excludedBy(path) ??
      (item.previous_filename && classifier.isSecretPath(item.previous_filename)
        ? SKIP_REASONS.secret
        : undefined);
    if (excluded) {
      skip(excluded);
      continue;
    }
    if (item.patch === undefined || item.patch === "") {
      skip(item.changes > 0 ? SKIP_REASONS.noPatch : SKIP_REASONS.noChanges);
      continue;
    }
    if (looksGenerated(path, item.patch)) {
      skip(SKIP_REASONS.generated);
      continue;
    }

    const redacted = redactPatch(item.patch);
    redactions += redacted.count;
    const file: ChangedFile = {
      path,
      ...(item.previous_filename && status === "renamed"
        ? { previousPath: item.previous_filename }
        : {}),
      status,
      additions: item.additions,
      deletions: item.deletions,
      patch: redacted.text,
      addedLines: addedLineRanges(parsePatch(redacted.text)),
    };
    candidates.push({ file, priority: classifier.priority(path) });
  }

  // ---- size policy
  const size = applySizePolicy({
    candidates,
    maxChangedFiles: config.review.max_changed_files,
    maxPatchCharacters: config.review.max_patch_characters,
  });
  skipped.push(...size.skipped);
  const files = size.included;

  const index = new DiffIndex();
  for (const file of files) index.add(file.path, file.patch);

  // ---- prior App comments, and test files; both are skipped when the review will not run
  let prior: PriorState = { fingerprints: [], comments: [] };
  let testFiles: Record<string, string[]> = {};
  if (size.limits.status !== "skipped") {
    signal?.throwIfAborted();
    const found = await collectPrior({
      client,
      repo,
      prNumber,
      ...(options.appLogin ? { appLogin: options.appLogin } : {}),
      signal,
    });
    prior = found.prior;
    if (found.truncated)
      warnings.push("Earlier review comments were truncated; some may be missed.");

    if (config.agents.test_coverage) {
      testFiles = await discoverTests(client, repo, headSha, files, signal, warnings);
    }
  }

  const title = redactSecrets(pull.title);
  const body = redactSecrets(pull.body ?? "");
  redactions += title.count + body.count;

  const patchCharacters = files.reduce((sum, f) => sum + (f.patch?.length ?? 0), 0);
  logger?.info("Context collected", {
    pr: prNumber,
    files: files.length,
    skipped: skipped.length,
    limits: size.limits.status,
    redactions,
  });

  return {
    pr: {
      number: pull.number,
      title: truncate(title.text, PR_TITLE_MAX_CHARACTERS),
      body: truncate(body.text, PR_BODY_MAX_CHARACTERS),
      author: pull.user?.login ?? "unknown",
      baseRef: pull.base.ref,
      baseSha,
      headSha,
      isDraft: pull.draft ?? false,
      isFork,
    },
    files,
    skippedFiles: skipped,
    testFiles,
    prior,
    limits: size.limits,
    config,
    warnings,
    stats: {
      changedFiles: reported,
      includedFiles: files.length,
      skippedFiles: skipped.length,
      patchCharacters,
      redactions,
    },
    isLineInDiff: (path, line) => index.isLineInDiff(path, line),
    isRangeInDiff: (path, start, end) => index.isRangeInDiff(path, start, end),
    diffPosition: (path, line) => index.position(path, line),
  };
}

async function discoverTests(
  client: ContextClient,
  repo: RepoRef,
  headSha: string,
  files: readonly ChangedFile[],
  signal: AbortSignal | undefined,
  warnings: string[],
): Promise<Record<string, string[]>> {
  try {
    const tree = await listTestFiles({ client, repo, sha: headSha, signal });
    if (tree.truncated) {
      warnings.push(
        "The repository is too large to list completely; test discovery may be incomplete.",
      );
    }
    return mapSourceFilesToTests(files, tree.tests, tree.packageRoots);
  } catch (err) {
    // Aborts and outages still propagate (the job retries); a tree that is missing, forbidden or malformed
    // degrades to "no test mapping".
    if (signal?.aborted) throw err;
    const status = (err as { status?: number } | null)?.status;
    const transient =
      status === undefined
        ? !(err instanceof UnexpectedResponseError)
        : status >= 500 || status === 429;
    if (transient) throw err;
    warnings.push("Test files could not be listed; test discovery was skipped.");
    return {};
  }
}
