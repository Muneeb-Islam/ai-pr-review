// Pull request events (FR-01, FR-02): automatic reviews, `/ai-review` comments and Check Run re-requests.
import { getRepository, getRunByCheckRunId } from "@ai-pr-review/db";
import { getInstallationByGitHubId } from "@ai-pr-review/db/system";
import { COMMAND_ALLOWED_ASSOCIATIONS, COMMENT_COMMAND } from "@ai-pr-review/shared";
import type { CheckRunEvent, IssueCommentEvent, PullRequestEvent } from "./payloads";
import { requestRun } from "./runs";
import { isTarget, resolveTarget } from "./target";
import { ignored, type HandlerResult, type WebhookDeps } from "./types";

const REVIEW_ACTIONS = new Set(["opened", "reopened", "synchronize", "ready_for_review"]);

export async function handlePullRequest(
  deps: WebhookDeps,
  event: PullRequestEvent,
): Promise<HandlerResult> {
  if (!REVIEW_ACTIONS.has(event.action)) return ignored("unsupported_action");

  const target = await resolveTarget(deps, event.installation?.id, event.repository);
  if (!isTarget(target)) return target;

  const pr = event.pull_request;
  return requestRun(deps, {
    ...target,
    trigger: "pull_request",
    ...(event.sender ? { triggeredBy: event.sender.login } : {}),
    baseSha: pr.base.sha,
    pr: {
      number: pr.number,
      baseRef: pr.base.ref,
      headSha: pr.head.sha,
      isDraft: pr.draft ?? false,
      // A deleted fork leaves `head.repo` null; both cases are fork PRs.
      isFork: pr.head.repo === null || pr.head.repo.full_name !== pr.base.repo.full_name,
    },
  });
}

/** `/ai-review` on its own, or followed by whitespace and more text (which is ignored). */
const isCommand = (body: string): boolean => {
  const trimmed = body.trimStart();
  return (
    trimmed.startsWith(COMMENT_COMMAND) &&
    (trimmed.length === COMMENT_COMMAND.length || /\s/.test(trimmed[COMMENT_COMMAND.length]!))
  );
};

const splitFullName = (fullName: string) => {
  const [owner = "", repo = ""] = fullName.split("/");
  return { owner, repo };
};

/**
 * `/ai-review` on a pull request starts a manual run for the PR's current head. Only the repository's
 * OWNER, MEMBER or COLLABORATOR may do it; everyone else (and bots) is ignored without a trace.
 */
export async function handleIssueComment(
  deps: WebhookDeps,
  event: IssueCommentEvent,
): Promise<HandlerResult> {
  // Cheap checks first: this event fires for every comment on every PR of every installation.
  if (event.action !== "created") return ignored("unsupported_action");
  if (event.issue.pull_request === undefined) return ignored("not_a_pull_request");
  if (!isCommand(event.comment.body)) return ignored("not_a_command");
  if (event.comment.user.type === "Bot") return ignored("bot_comment");
  if (
    !(COMMAND_ALLOWED_ASSOCIATIONS as readonly string[]).includes(event.comment.author_association)
  ) {
    return ignored("not_authorized");
  }

  const target = await resolveTarget(deps, event.installation?.id, event.repository);
  if (!isTarget(target)) return target;

  const snapshot = await deps.github.fetchPullRequest(
    target.installation.githubInstallationId,
    splitFullName(target.repo.fullName),
    event.issue.number,
  );
  if (snapshot.state !== "open") return ignored("pull_request_closed", target.installation.id);

  return requestRun(deps, {
    ...target,
    trigger: "comment_command",
    triggeredBy: event.comment.user.login,
    pr: snapshot.pr,
    baseSha: snapshot.baseSha,
  });
}

/**
 * "Re-run" on our Check Run: a new run linked to the one the check belongs to (`parent_run_id`). Re-running
 * a check of an outdated commit is ignored, so it cannot supersede the review of the current head.
 */
export async function handleCheckRun(
  deps: WebhookDeps,
  event: CheckRunEvent,
): Promise<HandlerResult> {
  if (event.action !== "rerequested") return ignored("unsupported_action");
  if (!event.installation) return ignored("no_installation");

  const installation = await getInstallationByGitHubId(deps.db, event.installation.id);
  if (!installation) return ignored("unknown_installation");
  if (installation.status !== "active") return ignored("installation_inactive", installation.id);

  // Only checks we created are known to us; any other app's check is not ours to re-run.
  const parent = await getRunByCheckRunId(deps.db, [installation.id], event.check_run.id);
  if (!parent) return ignored("not_our_check", installation.id);

  const repo = await getRepository(deps.db, [installation.id], parent.repoId);
  if (!repo) return ignored("unknown_repository", installation.id);
  if (!repo.active) return ignored("repository_inactive", installation.id);

  const snapshot = await deps.github.fetchPullRequest(
    installation.githubInstallationId,
    splitFullName(repo.fullName),
    parent.prNumber,
  );
  if (snapshot.state !== "open") return ignored("pull_request_closed", installation.id);
  if (snapshot.pr.headSha !== parent.headSha) return ignored("stale_head", installation.id);

  return requestRun(deps, {
    installation,
    repo,
    trigger: "check_run_rerequested",
    ...(event.sender ? { triggeredBy: event.sender.login } : {}),
    pr: snapshot.pr,
    baseSha: snapshot.baseSha,
    parentRunId: parent.id,
  });
}
