import { z } from "zod";
import { CHECK_RUN_NAME } from "@ai-pr-review/shared";
import type { RepoRef } from "../github/client";
import { call, commentSchema, repoParams, type ContextClient } from "../context/github";
import { hasSummaryMarker, parseFingerprintMarker } from "../context/markers";
import { isAppAuthor } from "../context/prior";
import type { CheckConclusion } from "./check";
import type { InlineComment } from "./inline";

// Every GitHub write the publisher makes (design §4). Each function takes the slice of Octokit that the context
// code also uses, so tests pass a fake, and carries the run's abort signal. Errors are thrown as they come;
// `classifyGitHubError` turns them into what the publisher does about them.

/** 403 and 401: the App lacks a permission. 422: GitHub rejected the payload. 404: gone. Else: unavailable. */
export type GitHubFailure = "denied" | "invalid" | "missing" | "unavailable";

export function classifyGitHubError(err: unknown): GitHubFailure {
  const status = (err as { status?: number } | null)?.status;
  if (status === 401 || status === 403) return "denied";
  if (status === 422) return "invalid";
  if (status === 404 || status === 410) return "missing";
  return "unavailable";
}

const idSchema = z.object({ id: z.number() });
const headSchema = z.object({ head: z.object({ sha: z.string() }) });

/** The commit the pull request points at right now. */
export async function fetchHeadSha(
  client: ContextClient,
  repo: RepoRef,
  prNumber: number,
  signal?: AbortSignal,
): Promise<string> {
  const pull = await call(
    client,
    signal,
    "GET /repos/{owner}/{repo}/pulls/{pull_number}",
    { ...repoParams(repo), pull_number: prNumber },
    headSchema,
  );
  return pull.head.sha;
}

/** What GitHub needs to anchor a review comment (the line API; `RIGHT` is the new side of the diff). */
function commentParams(c: InlineComment): Record<string, unknown> {
  return {
    path: c.path,
    line: c.line,
    side: "RIGHT",
    ...(c.startLine !== undefined ? { start_line: c.startLine, start_side: "RIGHT" } : {}),
    body: c.body,
  };
}

/**
 * One Pull Request Review with event `COMMENT` holding all inline comments (FR-33). Never approves or requests
 * changes. `commit_id` pins the comments to the commit that was reviewed. Returns the review id.
 */
export async function createReview(
  client: ContextClient,
  repo: RepoRef,
  prNumber: number,
  input: { headSha: string; comments: readonly InlineComment[] },
  signal?: AbortSignal,
): Promise<number> {
  const review = await call(
    client,
    signal,
    "POST /repos/{owner}/{repo}/pulls/{pull_number}/reviews",
    {
      ...repoParams(repo),
      pull_number: prNumber,
      commit_id: input.headSha,
      event: "COMMENT",
      comments: input.comments.map(commentParams),
    },
    idSchema,
  );
  return review.id;
}

/** The ids of a review's comments, matched to findings by the fingerprint marker in each body. */
export async function listReviewCommentIds(
  client: ContextClient,
  repo: RepoRef,
  prNumber: number,
  reviewId: number,
  signal?: AbortSignal,
): Promise<Map<string, number>> {
  const ids = new Map<string, number>();
  for (let page = 1; page <= 5; page += 1) {
    const batch = await call(
      client,
      signal,
      "GET /repos/{owner}/{repo}/pulls/{pull_number}/reviews/{review_id}/comments",
      { ...repoParams(repo), pull_number: prNumber, review_id: reviewId, per_page: 100, page },
      z.array(commentSchema),
    );
    for (const comment of batch) {
      const marker = comment.body ? parseFingerprintMarker(comment.body) : undefined;
      if (marker) ids.set(marker.fingerprint, comment.id);
    }
    if (batch.length < 100) break;
  }
  return ids;
}

/** A single review comment, the fallback when GitHub rejects a whole review: the good comments still land. */
export async function createReviewComment(
  client: ContextClient,
  repo: RepoRef,
  prNumber: number,
  input: { headSha: string; comment: InlineComment },
  signal?: AbortSignal,
): Promise<number> {
  const created = await call(
    client,
    signal,
    "POST /repos/{owner}/{repo}/pulls/{pull_number}/comments",
    {
      ...repoParams(repo),
      pull_number: prNumber,
      commit_id: input.headSha,
      ...commentParams(input.comment),
    },
    idSchema,
  );
  return created.id;
}

/**
 * Creates the summary comment, or updates it in place (FR-31). A comment is only edited after it has been read
 * back and found to carry our marker and to be authored by the App (FR-38); anything else is left alone and a
 * new comment is created.
 */
export async function upsertSummaryComment(
  client: ContextClient,
  repo: RepoRef,
  prNumber: number,
  input: { body: string; existingId?: number | undefined; appLogin?: string | undefined },
  signal?: AbortSignal,
): Promise<{ id: number; created: boolean }> {
  const base = repoParams(repo);
  if (input.existingId !== undefined) {
    const own = await ownSummary(client, repo, input.existingId, input.appLogin, signal);
    if (own) {
      try {
        const updated = await call(
          client,
          signal,
          "PATCH /repos/{owner}/{repo}/issues/comments/{comment_id}",
          { ...base, comment_id: input.existingId, body: input.body },
          idSchema,
        );
        return { id: updated.id, created: false };
      } catch (err) {
        if (classifyGitHubError(err) !== "missing") throw err;
      }
    }
  }
  const created = await call(
    client,
    signal,
    "POST /repos/{owner}/{repo}/issues/{issue_number}/comments",
    { ...base, issue_number: prNumber, body: input.body },
    idSchema,
  );
  return { id: created.id, created: true };
}

async function ownSummary(
  client: ContextClient,
  repo: RepoRef,
  commentId: number,
  appLogin: string | undefined,
  signal?: AbortSignal,
): Promise<boolean> {
  try {
    const comment = await call(
      client,
      signal,
      "GET /repos/{owner}/{repo}/issues/comments/{comment_id}",
      { ...repoParams(repo), comment_id: commentId },
      commentSchema,
    );
    return isAppAuthor(comment.user, appLogin) && !!comment.body && hasSummaryMarker(comment.body);
  } catch (err) {
    if (classifyGitHubError(err) === "missing") return false;
    throw err;
  }
}

// ---------- Check Run ----------

export interface CheckTarget {
  /** The Check Run created when the run was queued. When it is missing, one is created. */
  checkRunId?: number | null | undefined;
  headSha: string;
  /** The run id, so a Check Run can always be traced back to its run. */
  externalId: string;
  detailsUrl?: string | undefined;
}

export interface CheckOutput {
  title: string;
  summary: string;
}

const base = (target: CheckTarget) => ({
  name: CHECK_RUN_NAME,
  head_sha: target.headSha,
  external_id: target.externalId,
  ...(target.detailsUrl ? { details_url: target.detailsUrl } : {}),
});

/** Updates the Check Run, or creates one if it never existed or was removed. Returns its id. */
async function writeCheckRun(
  client: ContextClient,
  repo: RepoRef,
  target: CheckTarget,
  fields: Record<string, unknown>,
  signal?: AbortSignal,
): Promise<number> {
  const params = repoParams(repo);
  if (target.checkRunId) {
    try {
      const updated = await call(
        client,
        signal,
        "PATCH /repos/{owner}/{repo}/check-runs/{check_run_id}",
        { ...params, check_run_id: target.checkRunId, ...fields },
        idSchema,
      );
      return updated.id;
    } catch (err) {
      if (classifyGitHubError(err) !== "missing") throw err;
    }
  }
  const created = await call(
    client,
    signal,
    "POST /repos/{owner}/{repo}/check-runs",
    { ...params, ...base(target), ...fields },
    idSchema,
  );
  return created.id;
}

/** `in_progress`: the worker has the run. */
export function startCheckRun(
  client: ContextClient,
  repo: RepoRef,
  target: CheckTarget,
  now: Date,
  signal?: AbortSignal,
): Promise<number> {
  return writeCheckRun(
    client,
    repo,
    target,
    {
      status: "in_progress",
      started_at: now.toISOString(),
      output: { title: "Review in progress", summary: "The review is running." },
    },
    signal,
  );
}

/** `completed` with a conclusion and the output (FR-30). */
export function completeCheckRun(
  client: ContextClient,
  repo: RepoRef,
  target: CheckTarget,
  input: { conclusion: CheckConclusion; output: CheckOutput; now: Date },
  signal?: AbortSignal,
): Promise<number> {
  return writeCheckRun(
    client,
    repo,
    target,
    {
      status: "completed",
      conclusion: input.conclusion,
      completed_at: input.now.toISOString(),
      output: input.output,
    },
    signal,
  );
}
