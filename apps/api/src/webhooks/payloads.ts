// The parts of GitHub's webhook payloads the handlers use. zod strips everything else, so unrelated
// (and possibly large) fields never travel further than this file.
import { z } from "zod";

const githubId = z.number().int().positive();

const account = z.object({ login: z.string().min(1), type: z.string() });
const sender = z.object({ login: z.string().min(1), type: z.string().optional() });
const installationRef = z.object({ id: githubId });

/** Repository as listed by installation events (no default branch). */
const repoLite = z.object({
  id: githubId,
  full_name: z.string().min(1),
  private: z.boolean(),
});

/** Repository as delivered with pull request, comment and check events. */
const repoFull = repoLite.extend({
  owner: account,
  default_branch: z.string().min(1).optional(),
});

export const installationEvent = z.object({
  action: z.string(),
  installation: installationRef.extend({ account }),
  repositories: z.array(repoLite).optional(),
});

export const installationRepositoriesEvent = z.object({
  action: z.string(),
  installation: installationRef.extend({ account: account.optional() }),
  repositories_added: z.array(repoLite).default([]),
  repositories_removed: z.array(repoLite).default([]),
});

const pullRequestBranch = z.object({
  ref: z.string().min(1),
  sha: z.string().min(1),
  // `null` when the fork was deleted.
  repo: z.object({ full_name: z.string().min(1) }).nullable(),
});

export const pullRequestEvent = z.object({
  action: z.string(),
  pull_request: z.object({
    number: githubId,
    draft: z.boolean().optional(),
    base: pullRequestBranch.extend({ repo: z.object({ full_name: z.string().min(1) }) }),
    head: pullRequestBranch,
  }),
  repository: repoFull,
  installation: installationRef.optional(),
  sender: sender.optional(),
});

export const issueCommentEvent = z.object({
  action: z.string(),
  issue: z.object({
    number: githubId,
    // Present only when the issue is a pull request.
    pull_request: z.unknown().optional(),
  }),
  comment: z.object({
    body: z.string().default(""),
    author_association: z.string(),
    user: sender,
  }),
  repository: repoFull,
  installation: installationRef.optional(),
  sender: sender.optional(),
});

export const checkRunEvent = z.object({
  action: z.string(),
  check_run: z.object({ id: githubId }),
  repository: repoFull,
  installation: installationRef.optional(),
  sender: sender.optional(),
});

export type InstallationEvent = z.infer<typeof installationEvent>;
export type InstallationRepositoriesEvent = z.infer<typeof installationRepositoriesEvent>;
export type PullRequestEvent = z.infer<typeof pullRequestEvent>;
export type IssueCommentEvent = z.infer<typeof issueCommentEvent>;
export type CheckRunEvent = z.infer<typeof checkRunEvent>;
export type RepoPayload = z.infer<typeof repoFull>;
