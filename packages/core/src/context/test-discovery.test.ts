import { describe, expect, it } from "vitest";
import { createFakeGitHub } from "./test-support";
import { isJsTsTestFile, listTestFiles, mapSourceFilesToTests } from "./test-discovery";

const changed = (...paths: string[]) =>
  paths.map((path) => ({ path, status: "modified" as const }));

describe("isJsTsTestFile", () => {
  it.each([
    "src/a.test.ts",
    "src/a.spec.js",
    "src/a.test.tsx",
    "src/__tests__/a.ts",
    "test/a.js",
    "tests/unit/a.mjs",
    "packages/x/test/helpers/a.ts",
  ])("accepts %s", (path) => expect(isJsTsTestFile(path)).toBe(true));

  it.each(["src/a.ts", "src/test-utils.ts", "README.md", "test/data.json", "src/latest.ts"])(
    "rejects %s",
    (path) => expect(isJsTsTestFile(path)).toBe(false),
  );
});

describe("listTestFiles", () => {
  it("lists JS/TS test files from the tree at the head SHA, skipping vendored and build directories", async () => {
    const github = createFakeGitHub({
      tree: [
        { path: "src/a.ts" },
        { path: "src/a.test.ts" },
        { path: "test/b.spec.js" },
        { path: "node_modules/x/test/y.test.js" },
        { path: "dist/a.test.js" },
        { path: "src", type: "tree" },
        { path: "package.json" },
        { path: "packages/web/package.json" },
      ],
      treeTruncated: true,
    });
    const result = await listTestFiles({
      client: github.client,
      repo: { owner: "acme", repo: "widgets" },
      sha: "h".repeat(40),
    });
    expect(result.tests).toEqual(["src/a.test.ts", "test/b.spec.js"]);
    expect(result.packageRoots).toEqual(["", "packages/web"]);
    expect(result.truncated).toBe(true);
    expect(github.calls[0]?.params).toMatchObject({ tree_sha: "h".repeat(40), recursive: "1" });
  });
});

describe("mapSourceFilesToTests", () => {
  it("maps a source file to the test next to it", () => {
    expect(mapSourceFilesToTests(changed("src/a.ts"), ["src/a.test.ts", "src/b.test.ts"])).toEqual({
      "src/a.ts": ["src/a.test.ts"],
    });
  });

  it("finds tests in __tests__ next to the file", () => {
    expect(
      mapSourceFilesToTests(changed("src/util/a.ts"), ["src/util/__tests__/a.test.ts"]),
    ).toEqual({
      "src/util/a.ts": ["src/util/__tests__/a.test.ts"],
    });
  });

  it("finds tests in a mirrored test tree", () => {
    const tests = ["test/util/a.test.ts", "packages/core/test/routing/guards.test.ts"];
    expect(
      mapSourceFilesToTests(changed("src/util/a.ts", "packages/core/src/routing/guards.ts"), tests),
    ).toEqual({
      "src/util/a.ts": ["test/util/a.test.ts"],
      "packages/core/src/routing/guards.ts": ["packages/core/test/routing/guards.test.ts"],
    });
  });

  it("maps a file with no tests to an empty list", () => {
    expect(mapSourceFilesToTests(changed("src/orphan.ts"), ["src/a.test.ts"])).toEqual({
      "src/orphan.ts": [],
    });
  });

  it("matches a same-name test elsewhere in the same package, but not in another package", () => {
    const roots = ["", "packages/a", "packages/b"];
    const tests = ["packages/b/tests/e2e/service.spec.ts"];
    expect(
      mapSourceFilesToTests(
        changed("packages/b/src/service.ts", "packages/a/src/service.ts"),
        tests,
        roots,
      ),
    ).toEqual({
      "packages/b/src/service.ts": ["packages/b/tests/e2e/service.spec.ts"],
      "packages/a/src/service.ts": [],
    });
  });

  it("does not guess for generic names such as index", () => {
    expect(mapSourceFilesToTests(changed("src/a/index.ts"), ["src/b/index.test.ts"])).toEqual({
      "src/a/index.ts": [],
    });
  });

  it("skips tests, removed files, docs and non-JS/TS files", () => {
    const files = [
      { path: "src/a.test.ts", status: "modified" as const },
      { path: "src/old.ts", status: "removed" as const },
      { path: "README.md", status: "modified" as const },
      { path: "src/a.py", status: "modified" as const },
    ];
    expect(mapSourceFilesToTests(files, ["src/old.test.ts"])).toEqual({});
  });

  it("recognises a test file without the .test suffix inside __tests__", () => {
    expect(mapSourceFilesToTests(changed("src/a.ts"), ["src/__tests__/a.ts"])).toEqual({
      "src/a.ts": ["src/__tests__/a.ts"],
    });
  });
});
