import { mergeConfig, type RawConfig, type ResolvedConfig } from "@ai-pr-review/shared";
import type { ContextClient } from "./github";

// Fixtures and a fake GitHub for the context tests. Not exported from the package.

export const patch = (...lines: string[]): string => lines.join("\n");

/** One new file of three lines. */
export const ADDED_PATCH = patch(
  "@@ -0,0 +1,3 @@",
  "+export function add(a, b) {",
  "+  return a + b;",
  "+}",
);

/**
 * Two hunks: a replacement plus an insertion in the first, an insertion before a missing final newline in the
 * second. Positions: hunk 1 is 1–6, the second header is 7, hunk 2 is 8–12.
 */
export const MULTI_HUNK_PATCH = patch(
  "@@ -1,4 +1,5 @@",
  ' import a from "a";',
  "-const x = 1;",
  "+const x = 2;",
  "+const y = 3;",
  " export { x };",
  " ",
  "@@ -20,3 +21,4 @@ function foo() {",
  "   a();",
  "+  b();",
  "   c();",
  " }",
  "\\ No newline at end of file",
);

export const REMOVED_PATCH = patch("@@ -1,2 +0,0 @@", "-const gone = true;", "-export { gone };");

export const RENAMED_PATCH = patch(
  "@@ -1,2 +1,2 @@",
  " export const name = 1;",
  "-const old = 1;",
  "+const renamed = 1;",
);

/** Fake values shaped like real credentials. Built from parts so no scanner flags this file. */
export const FAKE = {
  github: `ghp_${"a1B2c3D4e5F6g7H8i9J0".repeat(2)}`,
  aws: `AKIA${"ABCDEFGHIJKLMNOP"}`,
  openai: `sk-${"proj1234567890abcdefghijkl"}`,
  slack: `xoxb-${"1234567890-abcdefghij"}`,
  bearer: `${"abcdefghijklmnopqrstuvwxyz0123456789"}`,
  privateKeyBody: "MIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQC7",
};

export function makeConfig(overrides: RawConfig = {}): ResolvedConfig {
  return mergeConfig({ provider: "deepseek", model: "test-model", ...overrides });
}

export const DASHBOARD: RawConfig = { provider: "deepseek", model: "test-model" };

export interface FakePull {
  number?: number;
  title?: string;
  body?: string | null;
  draft?: boolean;
  login?: string;
  baseRef?: string;
  baseSha?: string;
  headSha?: string;
  headRepo?: string | null;
  baseRepo?: string;
  changedFiles?: number;
}

export interface FakeFile {
  filename: string;
  status?: string;
  additions?: number;
  deletions?: number;
  changes?: number;
  patch?: string;
  previous_filename?: string;
}

export interface FakeComment {
  id: number;
  body: string;
  login?: string;
  type?: string;
  path?: string;
}

export interface FakeGitHubSetup {
  pull?: FakePull;
  files?: FakeFile[];
  /** Text of `.github/ai-pr-review.yml` at the base SHA; `undefined` answers 404. */
  configFile?: string;
  /** Text of the same file at the head SHA (what a PR author could have edited). */
  headConfigFile?: string;
  /** Files by path for the contents API at the head SHA. */
  contents?: Record<string, string>;
  reviewComments?: FakeComment[];
  issueComments?: FakeComment[];
  tree?: Array<{ path: string; type?: string }>;
  treeTruncated?: boolean;
  /** GitHub Actions data for the coverage tests: workflow runs of the head commit, their artifacts, the zips. */
  actions?: FakeActions;
  /** Routes that fail, by route prefix, with this HTTP status. */
  failures?: Record<string, number>;
}

export interface FakeActions {
  runs?: Array<{ id: number; status?: string; created_at?: string }>;
  /** Artifacts by workflow run id. */
  artifacts?: Record<
    number,
    Array<{
      id: number;
      name: string;
      size_in_bytes?: number;
      expired?: boolean;
      created_at?: string;
    }>
  >;
  /** What the download of an artifact answers with, by artifact id (bytes, or anything to test odd answers). */
  zips?: Record<number, unknown>;
}

export interface RecordedCall {
  route: string;
  params: Record<string, unknown>;
}

export function httpError(status: number): Error {
  return Object.assign(new Error(`HTTP ${status}`), { status });
}

const asComment = (c: FakeComment) => ({
  id: c.id,
  body: c.body,
  ...(c.path ? { path: c.path } : {}),
  user: { login: c.login ?? "ai-review[bot]", type: c.type ?? "Bot" },
});

/** A `ContextClient` answering the routes the context code uses, and a log of every call it received. */
export function createFakeGitHub(setup: FakeGitHubSetup = {}): {
  client: ContextClient;
  calls: RecordedCall[];
} {
  const calls: RecordedCall[] = [];
  const pull = setup.pull ?? {};
  const baseRepo = pull.baseRepo ?? "acme/widgets";
  const files = setup.files ?? [];

  const page = <T>(items: T[], params: Record<string, unknown>): T[] => {
    const perPage = Number(params["per_page"] ?? 30);
    const n = Number(params["page"] ?? 1);
    return items.slice((n - 1) * perPage, n * perPage);
  };

  const client: ContextClient = {
    async request(route, params = {}) {
      calls.push({ route, params });
      for (const [prefix, status] of Object.entries(setup.failures ?? {})) {
        if (route.startsWith(prefix)) throw httpError(status);
      }

      if (route === "GET /repos/{owner}/{repo}/pulls/{pull_number}") {
        return {
          data: {
            number: pull.number ?? 7,
            title: pull.title ?? "Add feature",
            body: pull.body === undefined ? "Description" : pull.body,
            draft: pull.draft ?? false,
            user: { login: pull.login ?? "octocat" },
            changed_files: pull.changedFiles ?? files.length,
            base: {
              ref: pull.baseRef ?? "main",
              sha: pull.baseSha ?? "b".repeat(40),
              repo: { full_name: baseRepo },
            },
            head: {
              sha: pull.headSha ?? "a".repeat(40),
              repo: pull.headRepo === null ? null : { full_name: pull.headRepo ?? baseRepo },
            },
          },
        };
      }
      if (route === "GET /repos/{owner}/{repo}/pulls/{pull_number}/files") {
        return { data: page(files, params) };
      }
      if (route === "GET /repos/{owner}/{repo}/contents/{path}") {
        const path = String(params["path"]);
        if (path === ".github/ai-pr-review.yml") {
          const baseSha = pull.baseSha ?? "b".repeat(40);
          const headSha = pull.headSha ?? "a".repeat(40);
          const text =
            params["ref"] === baseSha
              ? setup.configFile
              : params["ref"] === headSha
                ? setup.headConfigFile
                : undefined;
          if (text === undefined) throw httpError(404);
          return { data: contentOf(text) };
        }
        const text = setup.contents?.[path];
        if (text === undefined) throw httpError(404);
        return { data: contentOf(text) };
      }
      if (route === "GET /repos/{owner}/{repo}/pulls/{pull_number}/comments") {
        return { data: page((setup.reviewComments ?? []).map(asComment), params) };
      }
      if (route === "GET /repos/{owner}/{repo}/issues/{issue_number}/comments") {
        return { data: page((setup.issueComments ?? []).map(asComment), params) };
      }
      if (route === "GET /repos/{owner}/{repo}/git/trees/{tree_sha}") {
        return {
          data: {
            truncated: setup.treeTruncated ?? false,
            tree: (setup.tree ?? []).map((e) => ({ path: e.path, type: e.type ?? "blob" })),
          },
        };
      }
      if (setup.actions && route === "GET /repos/{owner}/{repo}/actions/runs") {
        return {
          data: {
            total_count: setup.actions.runs?.length ?? 0,
            workflow_runs: setup.actions.runs ?? [],
          },
        };
      }
      if (setup.actions && route === "GET /repos/{owner}/{repo}/actions/runs/{run_id}/artifacts") {
        const list = setup.actions.artifacts?.[Number(params["run_id"])] ?? [];
        const name = params["name"];
        const artifacts = typeof name === "string" ? list.filter((a) => a.name === name) : list;
        return { data: { total_count: artifacts.length, artifacts } };
      }
      if (
        setup.actions &&
        route === "GET /repos/{owner}/{repo}/actions/artifacts/{artifact_id}/{archive_format}"
      ) {
        const zip = setup.actions.zips?.[Number(params["artifact_id"])];
        if (zip === undefined) throw httpError(404);
        return { data: zip };
      }
      throw new Error(`Unexpected route in test: ${route}`);
    },
  };
  return { client, calls };
}

function contentOf(text: string): unknown {
  return {
    type: "file",
    size: Buffer.byteLength(text),
    encoding: "base64",
    content: Buffer.from(text).toString("base64"),
  };
}

/** `n` modified files of source code, each with a patch of roughly `chars` characters. */
export function manyFiles(n: number, chars = 200, prefix = "src/file"): FakeFile[] {
  return Array.from({ length: n }, (_, i) => ({
    filename: `${prefix}${i}.ts`,
    status: "modified",
    additions: 1,
    deletions: 0,
    changes: 1,
    patch: patch("@@ -1,1 +1,2 @@", " const a = 1;", `+// ${"x".repeat(Math.max(0, chars - 40))}`),
  }));
}

export const file = (
  filename: string,
  patchText: string = ADDED_PATCH,
  extra: Partial<FakeFile> = {},
): FakeFile => ({
  filename,
  status: "added",
  additions: 3,
  deletions: 0,
  changes: 3,
  patch: patchText,
  ...extra,
});
