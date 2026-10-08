// Phase 15 in the context code: pull requests from forks are reviewed under stricter limits (AC-23), and the secrets the
// process itself holds are masked wherever the redaction runs (AC-18).
import { registerSecret } from "@ai-pr-review/shared";
import { describe, expect, it } from "vitest";
import { collectContext } from "./collect";
import { redactPatch, redactSecrets } from "./redact";
import { createFakeGitHub, DASHBOARD, manyFiles } from "./test-support";

const collect = (pull: { headRepo?: string | null }, config = {}, count = 30) =>
  collectContext({
    octokit: createFakeGitHub({ files: manyFiles(count), pull }).client,
    repo: { owner: "acme", repo: "widgets" },
    prNumber: 7,
    config: { ...DASHBOARD, ...config },
  });

describe("fork pull requests", () => {
  it("are capped below the repository's own limits, with the rest listed as skipped and a warning", async () => {
    const context = await collect(
      { headRepo: "stranger/widgets" },
      { review: { max_changed_files: 40 } },
    );
    expect(context.pr.isFork).toBe(true);
    expect(context.config.review.max_changed_files).toBe(15);
    expect(context.config.review.max_inline_comments).toBe(8);
    expect(context.config.limits.max_requests).toBe(8);
    expect(context.files).toHaveLength(15);
    expect(context.skippedFiles).toHaveLength(15);
    expect(context.limits.status).toBe("limited");
    expect(context.warnings).toContain(
      "This pull request comes from a fork, so it was reviewed under stricter limits.",
    );
  });

  it("a fork whose repository was deleted counts as a fork", async () => {
    const context = await collect({ headRepo: null }, { review: { max_changed_files: 40 } });
    expect(context.pr.isFork).toBe(true);
    expect(context.files).toHaveLength(15);
  });

  it("the repository's own pull requests keep the configured limits and get no warning", async () => {
    const context = await collect({}, { review: { max_changed_files: 40 } });
    expect(context.pr.isFork).toBe(false);
    expect(context.config.review.max_changed_files).toBe(40);
    expect(context.files).toHaveLength(30);
    expect(context.warnings.join(" ")).not.toContain("fork");
  });

  it("a fork can be made stricter than the caps, never looser (a repo file cannot raise them either)", async () => {
    const stricter = await collect(
      { headRepo: "stranger/widgets" },
      { review: { max_changed_files: 10 } },
    );
    expect(stricter.files).toHaveLength(10);
    const file = ["review:", "  max_changed_files: 500", "  max_inline_comments: 500"].join("\n");
    const github = createFakeGitHub({
      files: manyFiles(30),
      pull: { headRepo: "stranger/widgets" },
      configFile: file,
    });
    const looser = await collectContext({
      octokit: github.client,
      repo: { owner: "acme", repo: "widgets" },
      prNumber: 7,
      config: DASHBOARD,
    });
    expect(looser.config.review.max_changed_files).toBe(15);
    expect(looser.config.review.max_inline_comments).toBe(8);
  });
});

describe("secrets of this process", () => {
  it("are masked in text and in patches whatever their format, one per line, keeping the line count", () => {
    registerSecret("platform-secret-with-no-known-format-77");
    const text = "a\nconst x = 'platform-secret-with-no-known-format-77';\nc";
    const out = redactSecrets(text);
    expect(out.text).toBe("a\nconst x = '[REDACTED:secret]';\nc");
    expect(out.count).toBe(1);

    const patch = "@@ -0,0 +1,2 @@\n+const y = 'platform-secret-with-no-known-format-77';\n+ok";
    const redacted = redactPatch(patch);
    expect(redacted.text.split("\n")).toHaveLength(3);
    expect(redacted.text).not.toContain("platform-secret-with-no-known-format-77");
    expect(redacted.text.split("\n")[1]!.startsWith("+")).toBe(true);
  });
});
