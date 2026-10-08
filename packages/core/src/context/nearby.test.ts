import { describe, expect, it } from "vitest";
import { createNearbyCodeReader, findEnclosingBlock } from "./nearby";
import { createFakeGitHub, FAKE } from "./test-support";
import type { ChangedFile } from "./types";

const repo = { owner: "acme", repo: "widgets" };
const HEAD = "a".repeat(40);

const SOURCE = [
  "import { x } from './x';", // 1
  "", // 2
  "export function first(a: number) {", // 3
  "  const b = a + 1;", // 4
  "  if (b > 2) {", // 5
  "    return b;", // 6
  "  }", // 7
  "  return 0;", // 8
  "}", // 9
  "", // 10
  "export class Box {", // 11
  "  open(flag: boolean) {", // 12
  "    return flag;", // 13
  "  }", // 14
  "}", // 15
].join("\n");

const changed = (path: string, status: ChangedFile["status"] = "modified"): ChangedFile => ({
  path,
  status,
  additions: 1,
  deletions: 0,
  addedLines: [],
});

const context = (...files: ChangedFile[]) => ({ files, pr: { headSha: HEAD } }) as never;

describe("findEnclosingBlock", () => {
  const lines = SOURCE.split("\n");

  it("returns the function that contains a line, closing brace included", () => {
    expect(findEnclosingBlock(lines, 5)).toEqual({ start: 2, end: 8 }); // line 6 → first()
  });

  it("does not treat an if block as the enclosing function", () => {
    expect(findEnclosingBlock(lines, 5)?.start).toBe(2);
  });

  it("returns the method, not the class, for a line in a method", () => {
    expect(findEnclosingBlock(lines, 12)).toEqual({ start: 11, end: 13 });
  });

  it("returns undefined for top-level code", () => {
    expect(findEnclosingBlock(lines, 0)).toBeUndefined();
  });
});

describe("createNearbyCodeReader (FR-07)", () => {
  it("reads the enclosing function at the head SHA", async () => {
    const github = createFakeGitHub({ contents: { "src/a.ts": SOURCE } });
    const reader = createNearbyCodeReader({
      client: github.client,
      repo,
      context: context(changed("src/a.ts")),
    });
    const result = await reader.read("src/a.ts", 6);
    expect(result).toMatchObject({
      ok: true,
      snippet: { startLine: 3, endLine: 9, enclosingFunction: true },
    });
    expect(github.calls[0]?.params).toMatchObject({ path: "src/a.ts", ref: HEAD });
  });

  it("falls back to a window of lines when there is no enclosing function", async () => {
    const github = createFakeGitHub({ contents: { "src/a.ts": SOURCE } });
    const reader = createNearbyCodeReader({
      client: github.client,
      repo,
      context: context(changed("src/a.ts")),
      limits: { radiusLines: 1 },
    });
    const result = await reader.read("src/a.ts", 1);
    expect(result).toMatchObject({
      ok: true,
      snippet: { startLine: 1, endLine: 2, enclosingFunction: false },
    });
  });

  it("fetches a file once", async () => {
    const github = createFakeGitHub({ contents: { "src/a.ts": SOURCE } });
    const reader = createNearbyCodeReader({
      client: github.client,
      repo,
      context: context(changed("src/a.ts")),
    });
    await reader.read("src/a.ts", 4);
    await reader.read("src/a.ts", 12);
    expect(github.calls).toHaveLength(1);
  });

  it("only reads files that are part of the review", async () => {
    const github = createFakeGitHub({ contents: { ".env": "A=1", "src/gone.ts": "x" } });
    const reader = createNearbyCodeReader({
      client: github.client,
      repo,
      context: context(changed("src/a.ts"), changed("src/gone.ts", "removed")),
    });
    expect(await reader.read(".env", 1)).toEqual({ ok: false, reason: "not_in_review" });
    expect(await reader.read("src/gone.ts", 1)).toEqual({ ok: false, reason: "not_in_review" });
    expect(github.calls).toHaveLength(0);
  });

  it("redacts secrets in the code it returns", async () => {
    const github = createFakeGitHub({
      contents: { "src/a.ts": `const a = 1;\nconst token = "${FAKE.github}";\nconst b = 2;` },
    });
    const reader = createNearbyCodeReader({
      client: github.client,
      repo,
      context: context(changed("src/a.ts")),
    });
    const result = await reader.read("src/a.ts", 2);
    expect(JSON.stringify(result)).not.toContain(FAKE.github);
    expect(JSON.stringify(result)).toContain("[REDACTED:github-token]");
  });

  it("reports missing and oversized files", async () => {
    const github = createFakeGitHub({ contents: { "src/big.ts": "x".repeat(2000) } });
    const reader = createNearbyCodeReader({
      client: github.client,
      repo,
      context: context(changed("src/big.ts"), changed("src/none.ts")),
      limits: { maxFileBytes: 1000 },
    });
    expect(await reader.read("src/big.ts", 1)).toEqual({ ok: false, reason: "too_large" });
    expect(await reader.read("src/none.ts", 1)).toEqual({ ok: false, reason: "not_found" });
  });

  it("stops at the snippet budget", async () => {
    const github = createFakeGitHub({ contents: { "src/a.ts": SOURCE } });
    const reader = createNearbyCodeReader({
      client: github.client,
      repo,
      context: context(changed("src/a.ts")),
      limits: { maxSnippets: 1 },
    });
    expect((await reader.read("src/a.ts", 4)).ok).toBe(true);
    expect(await reader.read("src/a.ts", 12)).toEqual({ ok: false, reason: "budget_exhausted" });
  });

  it("cuts an over-long snippet at a line boundary", async () => {
    const long = Array.from({ length: 200 }, (_, i) => `const v${i} = ${i};`).join("\n");
    const github = createFakeGitHub({ contents: { "src/a.ts": long } });
    const reader = createNearbyCodeReader({
      client: github.client,
      repo,
      context: context(changed("src/a.ts")),
      limits: { radiusLines: 100, maxSnippetCharacters: 200 },
    });
    const result = await reader.read("src/a.ts", 100);
    expect(result.ok && result.snippet.text.length).toBeLessThanOrEqual(200);
    expect(result.ok && result.snippet.text.split("\n")).toHaveLength(
      result.ok ? result.snippet.endLine - result.snippet.startLine + 1 : 0,
    );
  });
});
