// Test helpers for the webhook tests: payload fixtures, a fake GitHub gateway and a signed-request builder.
import { readFileSync } from "node:fs";
import type { GitHubGateway, PullRequestSnapshot } from "@ai-pr-review/core";
import { signWebhookPayload } from "@ai-pr-review/core";

export const SECRET = "test-webhook-secret";

const FIXTURES = new URL("../../../../fixtures/webhooks/", import.meta.url);

export type Json = Record<string, unknown>;

export function loadFixture(name: string): Json {
  return JSON.parse(readFileSync(new URL(`${name}.json`, FIXTURES), "utf8")) as Json;
}

const isObject = (v: unknown): v is Json =>
  typeof v === "object" && v !== null && !Array.isArray(v);

/** `base` with `patch` merged in; nested objects merge, everything else (arrays, scalars) is replaced. */
export function patch(base: Json, changes: Json): Json {
  const out: Json = { ...base };
  for (const [key, value] of Object.entries(changes)) {
    out[key] = isObject(out[key]) && isObject(value) ? patch(out[key], value) : value;
  }
  return out;
}

export function fixture(name: string, changes: Json = {}): Json {
  return patch(loadFixture(name), changes);
}

/** A pull request payload whose head SHA, number and branch are overridden. */
export function prEvent(
  action: string,
  options: {
    headSha?: string;
    number?: number;
    baseRef?: string;
    draft?: boolean;
    fork?: boolean;
  } = {},
): Json {
  const base = fixture(options.fork ? "pull_request.fork" : "pull_request.opened");
  const changes: Json = {
    action,
    number: options.number ?? (base.number as number),
    pull_request: {
      ...(options.number ? { number: options.number } : {}),
      ...(options.draft !== undefined ? { draft: options.draft } : {}),
      head: { ...(options.headSha ? { sha: options.headSha } : {}) },
      base: { ...(options.baseRef ? { ref: options.baseRef } : {}) },
    },
  };
  return patch(base, changes);
}

export const sha = (n: number): string => String(n).repeat(40).slice(0, 40);

export function sign(body: string | Buffer, secret = SECRET): string {
  return signWebhookPayload(secret, body);
}

/** A GitHub gateway that records calls and returns canned data. */
export class FakeGateway implements GitHubGateway {
  readonly fetchCalls: Array<{ installation: number; repo: string; pr: number }> = [];
  readonly checkRuns: Array<{ headSha: string; externalId: string; detailsUrl?: string }> = [];
  failCheckRun = false;
  failFetch = false;
  /** Holds `createQueuedCheckRun` until resolved, to observe the response before processing ends. */
  gate: Promise<void> | undefined;
  nextCheckRunId = 880_000;
  snapshot: PullRequestSnapshot = {
    pr: { number: 7, baseRef: "main", headSha: sha(1), isDraft: false, isFork: false },
    baseSha: sha(2),
    state: "open",
  };

  async fetchPullRequest(
    githubInstallationId: number,
    repo: { owner: string; repo: string },
    prNumber: number,
  ): Promise<PullRequestSnapshot> {
    this.fetchCalls.push({
      installation: githubInstallationId,
      repo: `${repo.owner}/${repo.repo}`,
      pr: prNumber,
    });
    if (this.failFetch) throw Object.assign(new Error("GitHub is down"), { status: 502 });
    return structuredClone(this.snapshot);
  }

  async createQueuedCheckRun(
    _githubInstallationId: number,
    _repo: { owner: string; repo: string },
    input: { headSha: string; externalId: string; detailsUrl?: string },
  ): Promise<number> {
    await this.gate;
    if (this.failCheckRun) throw Object.assign(new Error("Forbidden"), { status: 403 });
    this.checkRuns.push(input);
    return this.nextCheckRunId++;
  }
}
