import type { RepoRef } from "../github/client";
import {
  commentSchema,
  listPages,
  MAX_COMMENT_PAGES,
  repoParams,
  type ContextClient,
} from "./github";
import { hasSummaryMarker, parseFingerprintMarker } from "./markers";
import type { PriorState } from "./types";

export interface PriorOptions {
  client: ContextClient;
  repo: RepoRef;
  prNumber: number;
  /** Login of the App's bot user (`<slug>[bot]`). When omitted, any bot account's markers are accepted. */
  appLogin?: string;
  signal?: AbortSignal | undefined;
}

/** True if a comment's author is the App (`appLogin`), or any bot account when the App's login is unknown. */
export function isAppAuthor(
  user: { login: string; type?: string | undefined } | null | undefined,
  appLogin: string | undefined,
): boolean {
  if (!user) return false;
  if (appLogin !== undefined) return user.login.toLowerCase() === appLogin.toLowerCase();
  // A person can paste our marker into a comment. Only bot accounts count when we do not know our own login.
  return user.type === "Bot" && user.login.endsWith("[bot]");
}

/**
 * What the App already posted on this PR: inline comment fingerprints (per head SHA) and the maintained summary
 * comment. Only comments authored by the App count, so a user cannot suppress findings by planting a marker.
 */
export async function collectPrior(
  options: PriorOptions,
): Promise<{ prior: PriorState; truncated: boolean }> {
  const { client, repo, prNumber, appLogin, signal } = options;
  const base = { ...repoParams(repo) };

  const review = await listPages(
    client,
    signal,
    "GET /repos/{owner}/{repo}/pulls/{pull_number}/comments",
    { ...base, pull_number: prNumber },
    commentSchema,
    MAX_COMMENT_PAGES,
  );
  const issue = await listPages(
    client,
    signal,
    "GET /repos/{owner}/{repo}/issues/{issue_number}/comments",
    { ...base, issue_number: prNumber },
    commentSchema,
    MAX_COMMENT_PAGES,
  );

  const comments: PriorState["comments"] = [];
  const fingerprints = new Set<string>();
  for (const comment of review.items) {
    if (!isAppAuthor(comment.user, appLogin) || !comment.body) continue;
    const marker = parseFingerprintMarker(comment.body);
    if (!marker) continue;
    fingerprints.add(marker.fingerprint);
    comments.push({
      id: comment.id,
      fingerprint: marker.fingerprint,
      headSha: marker.headSha,
      ...(comment.path ? { path: comment.path } : {}),
    });
  }

  let summaryCommentId: number | undefined;
  for (const comment of issue.items) {
    if (isAppAuthor(comment.user, appLogin) && comment.body && hasSummaryMarker(comment.body)) {
      summaryCommentId = comment.id; // the latest one wins
    }
  }

  return {
    prior: {
      fingerprints: [...fingerprints],
      comments,
      ...(summaryCommentId !== undefined ? { summaryCommentId } : {}),
    },
    truncated: review.truncated || issue.truncated,
  };
}
