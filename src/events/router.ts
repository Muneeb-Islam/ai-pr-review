import { z } from "zod";
import { COMMENT_COMMAND } from "../constants";
import type { Classification, PullRequestInfo } from "./types";

export const PULL_REQUEST_ACTIONS = ["opened", "reopened", "synchronize", "ready_for_review"];
export const COMMAND_ASSOCIATIONS = ["OWNER", "MEMBER", "COLLABORATOR"];

const repoRef = z.looseObject({ full_name: z.string() });
const pullRequestPayload = z.looseObject({
  action: z.string(),
  pull_request: z.looseObject({
    number: z.number().int().positive(),
    draft: z.boolean().optional(),
    base: z.looseObject({ ref: z.string(), repo: repoRef }),
    head: z.looseObject({ sha: z.string(), repo: repoRef.nullable() }),
  }),
});
const issueCommentPayload = z.looseObject({
  action: z.string(),
  issue: z.looseObject({
    number: z.number().int().positive(),
    pull_request: z.unknown().optional(),
  }),
  comment: z.looseObject({ body: z.string(), author_association: z.string() }),
});

export interface RouterInput {
  eventName: string;
  payload: unknown;
  /** Value of the `pr_number` Action input (workflow_dispatch). */
  prNumberInput?: string;
}

const ignore = (reason: string): Classification => ({ kind: "ignore", reason });

/** Step 1: classify the raw event. No I/O and needs no config. */
export function classifyEvent(input: RouterInput): Classification {
  switch (input.eventName) {
    case "pull_request":
      return classifyPullRequest(input.payload);
    case "workflow_dispatch":
      return classifyDispatch(input.prNumberInput);
    case "issue_comment":
      return classifyComment(input.payload);
    default:
      return ignore(`Event "${input.eventName}" is not supported; nothing to do.`);
  }
}

function classifyPullRequest(payload: unknown): Classification {
  const parsed = pullRequestPayload.safeParse(payload);
  if (!parsed.success) return ignore("pull_request payload is missing expected fields.");
  const { action, pull_request: pr } = parsed.data;
  if (!PULL_REQUEST_ACTIONS.includes(action)) {
    return ignore(`pull_request action "${action}" is not handled.`);
  }
  const info: PullRequestInfo = {
    number: pr.number,
    baseRef: pr.base.ref,
    headSha: pr.head.sha,
    isDraft: pr.draft ?? false,
    // A deleted fork has no head.repo; treat it as a fork.
    isFork: pr.head.repo === null || pr.head.repo.full_name !== pr.base.repo.full_name,
  };
  return { kind: "pr", trigger: "pull_request", pr: info };
}

function classifyDispatch(prNumberInput: string | undefined): Classification {
  const raw = prNumberInput?.trim();
  if (!raw) return ignore("workflow_dispatch run has no pr_number input.");
  const prNumber = Number(raw);
  if (!Number.isInteger(prNumber) || prNumber <= 0) {
    return ignore(`workflow_dispatch pr_number "${raw}" is not a valid PR number.`);
  }
  return { kind: "needs_fetch", trigger: "workflow_dispatch", prNumber };
}

function classifyComment(payload: unknown): Classification {
  const parsed = issueCommentPayload.safeParse(payload);
  if (!parsed.success) return ignore("issue_comment payload is missing expected fields.");
  const { action, issue, comment } = parsed.data;
  if (action !== "created") return ignore(`issue_comment action "${action}" is not handled.`);
  if (issue.pull_request === undefined)
    return ignore("Comment is on an issue, not a pull request.");
  const body = comment.body.trimStart();
  if (!body.startsWith(COMMENT_COMMAND))
    return ignore(`Comment does not start with ${COMMENT_COMMAND}.`);
  if (!COMMAND_ASSOCIATIONS.includes(comment.author_association)) {
    return ignore(
      `${COMMENT_COMMAND} ignored: commenter association is not OWNER, MEMBER or COLLABORATOR.`,
    );
  }
  return { kind: "needs_fetch", trigger: "comment_command", prNumber: issue.number };
}
