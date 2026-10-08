import { describe, expect, it } from "vitest";
import { createFakeGitHub, file, patch, type FakeActions } from "../context/test-support";
import { buildContext } from "../agents/test-support";
import { measureCoverage, selectCoverageFiles } from "./measure";
import { fixture } from "./fixtures";
import { lcovRecord, lcovZip } from "./test-support";

const REPO = { owner: "acme", repo: "widgets" };
const HEAD = "a".repeat(40);

// Lines 1-6 added; the report below runs 1, 2 and 5 and misses 3, 4 and 6.
const SOURCE_PATCH = patch(
  "@@ -0,0 +1,6 @@",
  "+export function f(a) {",
  "+  if (a) {",
  "+    return 1;",
  "+  }",
  "+  return 2;",
  "+}",
);

const actionsWith = (lcov: string): FakeActions => ({
  runs: [{ id: 10, status: "completed" }],
  artifacts: { 10: [{ id: 500, name: "coverage", size_in_bytes: 500 }] },
  zips: { 500: new Uint8Array(lcovZip(lcov)) },
});

async function measure(lcov: string | undefined, files = [file("src/f.ts", SOURCE_PATCH)]) {
  const context = await buildContext(files);
  const github = createFakeGitHub({
    actions: lcov === undefined ? { runs: [] } : actionsWith(lcov),
  });
  return measureCoverage({
    client: github.client,
    repo: REPO,
    headSha: HEAD,
    files: context.files,
    artifactName: "coverage",
    lcovPath: "lcov.info",
  });
}

describe("measureCoverage", () => {
  it("measures changed-line coverage from the artifact (AC-6)", async () => {
    const summary = await measure(
      lcovRecord("src/f.ts", [
        [1, 3],
        [2, 3],
        [3, 0],
        [5, 3],
        [6, 0],
      ]),
    );
    expect(summary).toMatchObject({
      status: "measured",
      coveredLines: 3,
      totalLines: 5,
      artifact: { name: "coverage", runId: 10 },
    });
    expect(summary.changedLineCoverage).toBeCloseTo(0.6);
    expect(summary.files?.[0]?.uncovered).toEqual([
      { start: 3, end: 3 },
      { start: 6, end: 6 },
    ]);
  });

  it("matches the report's Windows paths to the pull request's files", async () => {
    const summary = await measure(fixture("jest.lcov"), [file("src/math.js", SOURCE_PATCH)]);
    expect(summary.status).toBe("measured");
    expect(summary.files?.[0]?.status).toBe("measured");
  });

  it("says plainly that coverage could not be measured when there is no artifact (FR-23)", async () => {
    const summary = await measure(undefined);
    expect(summary).toMatchObject({ status: "not_available", reasonCode: "no_runs" });
    expect(summary.reason).toBe("No CI workflow run was found for this commit.");
    expect(summary.changedLineCoverage).toBeUndefined();
  });

  it.each([
    ["an empty report", "", "lcov_empty"],
    ["a file that is not LCOV", "<html>nope</html>", "lcov_invalid"],
  ])("%s", async (_name, lcov, code) => {
    expect(await measure(lcov)).toMatchObject({ status: "not_available", reasonCode: code });
  });

  it("is not available without GitHub access", async () => {
    const context = await buildContext([file("src/f.ts", SOURCE_PATCH)]);
    const summary = await measureCoverage({
      client: undefined,
      repo: undefined,
      headSha: HEAD,
      files: context.files,
      artifactName: "coverage",
      lcovPath: "lcov.info",
    });
    expect(summary).toMatchObject({ status: "not_available", reasonCode: "no_client" });
  });

  it("skips pull requests that change no source file (nothing to measure)", async () => {
    const summary = await measure(lcovRecord("a.ts", [[1, 1]]), [
      file("README.md"),
      file("src/f.test.ts", SOURCE_PATCH),
    ]);
    expect(summary).toMatchObject({ status: "skipped", reasonCode: "no_source_files" });
  });

  it("does not ask GitHub when there is nothing to measure", async () => {
    const context = await buildContext([file("docs/guide.md")]);
    const github = createFakeGitHub({ actions: { runs: [] } });
    await measureCoverage({
      client: github.client,
      repo: REPO,
      headSha: HEAD,
      files: context.files,
      artifactName: "coverage",
      lcovPath: "lcov.info",
    });
    expect(github.calls.filter((c) => c.route.includes("/actions/"))).toHaveLength(0);
  });
});

describe("selectCoverageFiles", () => {
  it("keeps JS/TS source that was added or changed, not tests, deletions or other languages", async () => {
    const context = await buildContext([
      file("src/a.ts"),
      file("src/b.jsx"),
      file("src/a.test.ts"),
      file("test/helper.ts"),
      file("src/c.py"),
      file("docs/readme.md"),
      file("src/gone.ts", patch("@@ -1,2 +0,0 @@", "-const x = 1;", "-export { x };"), {
        status: "removed",
        additions: 0,
        deletions: 2,
      }),
    ]);
    expect(selectCoverageFiles(context.files).map((f) => f.path)).toEqual([
      "src/a.ts",
      "src/b.jsx",
    ]);
  });
});
