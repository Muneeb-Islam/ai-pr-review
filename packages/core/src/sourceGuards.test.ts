// Guards over the whole code base (Phase 15, AC-9, AC-18): properties that hold today because of how the code is
// organised, and that a future change could break without any single test noticing. Each guard names the rule, scans the
// runtime source (not tests, not scripts) and fails with the file that broke it.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { decide } from "./routing/guards";
import { mergeConfig } from "@ai-pr-review/shared";
import { describe, expect, it } from "vitest";

const root = fileURLToPath(new URL("../../../", import.meta.url));

/** Every runtime `.ts`/`.tsx` file under `apps/*\/src` and `packages/*\/src`: no tests, fixtures or test support. */
function runtimeFiles(): Array<{ path: string; text: string }> {
  const out: Array<{ path: string; text: string }> = [];
  const walk = (dir: string): void => {
    for (const name of readdirSync(dir)) {
      if (["node_modules", "dist", "__fixtures__", "test", "testing"].includes(name)) continue;
      const full = join(dir, name);
      if (statSync(full).isDirectory()) {
        walk(full);
        continue;
      }
      if (!/\.(ts|tsx)$/.test(name)) continue;
      if (
        /\.(test|spec)\.tsx?$/.test(name) ||
        /(^|[-.])(testing|test-support|fixtures)\.tsx?$/.test(name)
      ) {
        continue;
      }
      out.push({
        path: relative(root, full).split(sep).join("/"),
        text: readFileSync(full, "utf8"),
      });
    }
  };
  for (const group of ["apps", "packages"]) {
    for (const pkg of readdirSync(join(root, group))) {
      const src = join(root, group, pkg, "src");
      try {
        walk(src);
      } catch {
        // no src directory
      }
    }
  }
  return out;
}

const files = runtimeFiles();

describe("no repository code is ever executed or checked out (AC-9)", () => {
  it("finds the source to scan (a guard that scans nothing proves nothing)", () => {
    expect(files.length).toBeGreaterThan(150);
    expect(files.some((f) => f.path === "apps/worker/src/processor.ts")).toBe(true);
    expect(files.some((f) => f.path === "packages/core/src/context/collect.ts")).toBe(true);
  });

  it("no runtime module starts a process, evaluates a string, or loads code from data", () => {
    const forbidden: Array<[string, RegExp]> = [
      ["a child process", /\b(?:node:)?child_process\b/],
      ["a worker thread", /\bnode:worker_threads\b|from "worker_threads"/],
      ["the vm module", /\bnode:vm\b|from "vm"/],
      ["eval", /(?<![\w.])eval\s*\(/],
      ["new Function", /new\s+Function\s*\(/],
      ["a git client", /\bsimple-git\b|\bnodegit\b|\bisomorphic-git\b/],
      ["a shell runner", /\bexeca\b|\bshelljs\b|\bcross-spawn\b/],
      ["a dynamic import of a computed path", /import\(\s*[^"'`\s)]/],
    ];
    // The dependency rules of the Security agent list popular package NAMES (execa, shelljs, cross-spawn) to spot imitations.
    const names = new Set(["packages/core/src/security/dependencies.ts"]);
    const hits = files
      .filter((f) => !names.has(f.path))
      .flatMap((f) =>
        forbidden
          .filter(([, pattern]) => pattern.test(f.text))
          .map(([what]) => `${f.path}: ${what}`),
      );
    expect(
      hits,
      "a runtime module must not run code. Repository content is read through the GitHub API only.",
    ).toEqual([]);
  });

  it("nothing downloads or extracts a repository: only API reads of the pull request, contents, trees and artifacts", () => {
    // The same file, which looks for tarball and git sources in the DEPENDENCIES of a pull request (it reads text, nothing else).
    const hits = files
      .filter((f) => f.path !== "packages/core/src/security/dependencies.ts")
      .flatMap((f) =>
        /tarball|zipball|git clone|\/git\/blobs|raw\.githubusercontent|\.git\b.*(clone|fetch)/i.test(
          f.text,
        )
          ? [f.path]
          : [],
      );
    expect(hits).toEqual([]);
  });

  it("the only file reads in runtime code are configuration, migrations and the OpenAPI document, never repository content", () => {
    // Runtime code that touches the file system, with the reason.
    const allowed: Record<string, string> = {
      "packages/shared/src/env.ts": "secrets from files (NAME_FILE)",
      "packages/shared/src/config/loader.ts":
        "the repository config file of the local replay tooling",
      "packages/shared/src/config/validate.ts": "the same",
      "packages/shared/src/config/jsonSchema.ts": "writes the JSON schema at build time",
      "packages/db/src/migrate.ts": "locates the SQL migrations",
      "packages/db/src/seed.ts": "reads the demo fixtures",
      "apps/worker/src/liveness.ts": "touches its own liveness file",
      "apps/api/src/config.ts": "none",
    };
    const fsUsers = files
      .filter((f) => /from "node:fs"|from "fs"|node:fs\/promises|require\("fs"\)/.test(f.text))
      .map((f) => f.path)
      .filter((path) => !(path in allowed));
    expect(
      fsUsers,
      "a new module that reads or writes files: add it to the list above with the reason",
    ).toEqual([]);
  });

  it("the pull request routes the engine calls are reads, plus the review, comment and check-run writes of the publisher", () => {
    const routes = new Set<string>();
    for (const f of files.filter((x) => x.path.startsWith("packages/core/src"))) {
      for (const m of f.text.matchAll(/"((?:GET|POST|PATCH|PUT|DELETE) \/[^"]+)"/g))
        routes.add(m[1]!);
    }
    const writes = [...routes].filter((r) => !r.startsWith("GET "));
    expect(writes.sort()).toEqual(
      [
        "PATCH /repos/{owner}/{repo}/check-runs/{check_run_id}",
        "PATCH /repos/{owner}/{repo}/issues/comments/{comment_id}",
        "POST /app/installations/{installation_id}/access_tokens",
        "POST /repos/{owner}/{repo}/check-runs",
        "POST /repos/{owner}/{repo}/issues/{issue_number}/comments",
        "POST /repos/{owner}/{repo}/pulls/{pull_number}/comments",
        "POST /repos/{owner}/{repo}/pulls/{pull_number}/reviews",
      ].sort(),
    );
    // Nothing merges, approves, pushes or edits a file.
    for (const route of routes)
      expect(route).not.toMatch(
        /merge|\/git\/(refs|commits|trees)\b.*POST|PUT \/repos\/.*\/contents/,
      );
  });
});

describe("provider keys stay with the provider adapter (AC-9, AC-18)", () => {
  it("only these modules mention an API key; any other that starts to is a code path to review", () => {
    const allowed = new Set([
      "packages/core/src/providers/anthropic.ts",
      "packages/core/src/providers/openai-compatible.ts",
      "packages/core/src/providers/openai.ts",
      "packages/core/src/providers/deepseek.ts",
      "packages/core/src/providers/create.ts",
      "packages/core/src/providers/http-provider.ts",
      "packages/core/src/providers/test-connection.ts",
      "packages/core/src/providers/types.ts",
      "packages/core/src/providers/transport.ts",
      "packages/core/src/providers/errors.ts",
      "packages/core/src/net/outbound.ts",
      "packages/core/src/crypto/context.ts",
      "apps/worker/src/credentials.ts",
      "apps/worker/src/processor.ts",
      "apps/api/src/credentials/probe.ts",
      "apps/api/src/routes/credentials.ts",
      "packages/shared/src/api/contract.ts",
      "packages/shared/src/api/schemas.ts",
      "packages/shared/src/api/openapi.ts",
      "packages/shared/src/types/index.ts",
    ]);
    const mentions = files
      .filter((f) => /\bapiKey\b|\bapi_key\b/.test(f.text))
      .map((f) => f.path)
      .filter(
        (p) => !allowed.has(p) && !p.startsWith("apps/web/") && !p.startsWith("packages/db/"),
      );
    expect(
      mentions,
      "this module handles an API key: is it on a path that sees pull request data?",
    ).toEqual([]);
  });

  it("the context, agent, validation, prompt and publisher modules never see a key: it is not a parameter anywhere in them", () => {
    const dirs = [
      "context",
      "agents",
      "validation",
      "prompts",
      "publisher",
      "security",
      "test-coverage",
      "lifecycle",
    ];
    const offenders = files
      .filter((f) => dirs.some((d) => f.path.startsWith(`packages/core/src/${d}/`)))
      // Its patterns spot assignments to names like api_key in text; it never receives one.
      .filter((f) => f.path !== "packages/core/src/security/sanitize.ts")
      .filter((f) =>
        /\bapiKey\b|\bapi_key\b|\bproviderKey\b|\bciphertext\b|ENCRYPTION_KEY/i.test(f.text),
      )
      .map((f) => f.path);
    expect(offenders).toEqual([]);
  });

  it("database access to key ciphertext is limited to the worker, rotation and the credential endpoints", () => {
    const users = files
      .filter((f) => /\bciphertext\b/.test(f.text))
      .map((f) => f.path)
      .filter(
        (p) => !p.startsWith("packages/db/src/") && !p.startsWith("packages/core/src/crypto/"),
      );
    expect(users.sort()).toEqual(
      [
        "apps/api/src/routes/credentials.ts",
        "apps/worker/src/credentials.ts",
        "apps/worker/src/rotation.ts",
      ].sort(),
    );
  });
});

describe("fork pull requests are skipped unless an administrator opts in (AC-9)", () => {
  const fork = {
    number: 1,
    baseRef: "main",
    headSha: "a".repeat(40),
    isDraft: false,
    isFork: true,
  };

  it("the default configuration skips them, for an automatic event and for a comment command", () => {
    const config = mergeConfig({ provider: "deepseek", model: "m" });
    expect(config.fork_prs).toBe("skip");
    expect(decide("pull_request", fork, config)).toMatchObject({ action: "skip" });
    expect(decide("comment_command", fork, config)).toMatchObject({ action: "skip" });
    expect(decide("dashboard_rerun", fork, config)).toMatchObject({ action: "skip" });
  });

  it("only an explicit opt-in reviews them", () => {
    const config = mergeConfig({ provider: "deepseek", model: "m", fork_prs: "review" });
    expect(decide("pull_request", fork, config)).toMatchObject({ action: "review" });
  });

  it("the repository file and the dashboard cannot turn fork review on by accident: the schema accepts only skip or review", () => {
    expect(() =>
      mergeConfig({ provider: "deepseek", model: "m", fork_prs: "yes" as never }),
    ).toThrow();
  });
});
