import { httpError, type RecordedCall } from "../context/test-support";
import type { ContextClient } from "../context/github";

// A GitHub that remembers what the publisher writes: reviews and their comments, issue comments and Check Runs.
// For the publisher tests in this package and the worker's. Not for production code.

export interface FakeIssueComment {
  id: number;
  body: string;
  login?: string;
  type?: string;
}

export interface FakeCheckRun {
  id: number;
  status: string;
  conclusion?: string;
  output?: { title: string; summary: string };
  headSha?: string;
  externalId?: string;
}

export interface FakePublisherSetup {
  /** The commit the pull request points at (default "a" x 40). */
  headSha?: string;
  issueComments?: FakeIssueComment[];
  checkRuns?: FakeCheckRun[];
  /** Routes that fail, by route prefix, with this HTTP status (403, 422, 500, ...). */
  failures?: Record<string, number>;
  /** A review or review comment at one of these paths is rejected with 422 (a bad position). */
  invalidPaths?: string[];
  /** Everyone's comments are authored by this account unless they say otherwise. */
  appLogin?: string;
}

export interface FakeReview {
  id: number;
  event: string;
  commitId: string;
  comments: Array<{ id: number; path: string; line: number; startLine?: number; body: string }>;
}

export interface FakePublisherGitHub {
  client: ContextClient;
  calls: RecordedCall[];
  /** Mutable: tests can move the head to simulate a push. */
  state: {
    headSha: string;
    reviews: FakeReview[];
    /** Review comments created one at a time (the fallback after a rejected review). */
    singleComments: FakeReview["comments"];
    issueComments: Required<FakeIssueComment>[];
    checkRuns: FakeCheckRun[];
  };
}

export function createFakePublisherGitHub(setup: FakePublisherSetup = {}): FakePublisherGitHub {
  const calls: RecordedCall[] = [];
  const appLogin = setup.appLogin ?? "ai-review[bot]";
  let nextId = 1000;
  const state: FakePublisherGitHub["state"] = {
    headSha: setup.headSha ?? "a".repeat(40),
    reviews: [],
    singleComments: [],
    issueComments: (setup.issueComments ?? []).map((c) => ({
      login: appLogin,
      type: "Bot",
      ...c,
    })),
    checkRuns: [...(setup.checkRuns ?? [])],
  };
  const invalid = new Set(setup.invalidPaths ?? []);
  const withoutRequest = (params: Record<string, unknown>) => {
    const { request: _request, ...rest } = params;
    return rest;
  };

  const client: ContextClient = {
    async request(route, rawParams = {}) {
      const params = withoutRequest(rawParams);
      calls.push({ route, params });
      for (const [prefix, status] of Object.entries(setup.failures ?? {})) {
        if (route.startsWith(prefix)) throw httpError(status);
      }

      if (route === "GET /repos/{owner}/{repo}/pulls/{pull_number}") {
        return { data: { head: { sha: state.headSha } } };
      }

      if (route === "POST /repos/{owner}/{repo}/pulls/{pull_number}/reviews") {
        const comments = (params["comments"] as Array<Record<string, unknown>>) ?? [];
        if (comments.some((c) => invalid.has(String(c["path"])))) throw httpError(422);
        const review: FakeReview = {
          id: nextId++,
          event: String(params["event"]),
          commitId: String(params["commit_id"]),
          comments: comments.map((c) => ({
            id: nextId++,
            path: String(c["path"]),
            line: Number(c["line"]),
            ...(c["start_line"] !== undefined ? { startLine: Number(c["start_line"]) } : {}),
            body: String(c["body"]),
          })),
        };
        state.reviews.push(review);
        return { data: { id: review.id } };
      }

      if (route === "GET /repos/{owner}/{repo}/pulls/{pull_number}/reviews/{review_id}/comments") {
        const review = state.reviews.find((r) => r.id === params["review_id"]);
        const all = review?.comments ?? [];
        const perPage = Number(params["per_page"] ?? 30);
        const page = Number(params["page"] ?? 1);
        return {
          data: all
            .slice((page - 1) * perPage, page * perPage)
            .map((c) => ({ id: c.id, body: c.body, path: c.path })),
        };
      }

      if (route === "POST /repos/{owner}/{repo}/pulls/{pull_number}/comments") {
        if (invalid.has(String(params["path"]))) throw httpError(422);
        const comment = {
          id: nextId++,
          path: String(params["path"]),
          line: Number(params["line"]),
          body: String(params["body"]),
        };
        state.singleComments.push(comment);
        return { data: { id: comment.id } };
      }

      if (route === "GET /repos/{owner}/{repo}/issues/comments/{comment_id}") {
        const c = state.issueComments.find((x) => x.id === params["comment_id"]);
        if (!c) throw httpError(404);
        return { data: { id: c.id, body: c.body, user: { login: c.login, type: c.type } } };
      }
      if (route === "PATCH /repos/{owner}/{repo}/issues/comments/{comment_id}") {
        const c = state.issueComments.find((x) => x.id === params["comment_id"]);
        if (!c) throw httpError(404);
        c.body = String(params["body"]);
        return { data: { id: c.id } };
      }
      if (route === "POST /repos/{owner}/{repo}/issues/{issue_number}/comments") {
        const c = { id: nextId++, body: String(params["body"]), login: appLogin, type: "Bot" };
        state.issueComments.push(c);
        return { data: { id: c.id } };
      }

      if (route === "POST /repos/{owner}/{repo}/check-runs") {
        const run: FakeCheckRun = {
          id: nextId++,
          status: String(params["status"]),
          headSha: String(params["head_sha"]),
          externalId: String(params["external_id"]),
          ...(params["conclusion"] ? { conclusion: String(params["conclusion"]) } : {}),
          ...(params["output"] ? { output: params["output"] as FakeCheckRun["output"] } : {}),
        };
        state.checkRuns.push(run);
        return { data: { id: run.id } };
      }
      if (route === "PATCH /repos/{owner}/{repo}/check-runs/{check_run_id}") {
        const run = state.checkRuns.find((c) => c.id === params["check_run_id"]);
        if (!run) throw httpError(404);
        if (params["status"]) run.status = String(params["status"]);
        if (params["conclusion"]) run.conclusion = String(params["conclusion"]);
        if (params["output"]) run.output = params["output"] as FakeCheckRun["output"];
        return { data: { id: run.id } };
      }

      throw new Error(`Unexpected route in test: ${route}`);
    },
  };
  return { client, calls, state };
}
