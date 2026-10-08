// The production bundles start (found in Phase 15: they did not). `npm run build` bundles each backend app into one file with
// esbuild; a bundled CommonJS dependency that calls `require` for a Node module breaks an ES-module bundle only when it runs.
// This builds the api and the worker the way the images do and starts each with an empty environment: a bundle that loads
// reaches its own configuration check and says which variables are missing, by name.
import { execFileSync, spawnSync } from "node:child_process";
import { rmSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it, vi } from "vitest";

vi.setConfig({ testTimeout: 60_000 });

const root = fileURLToPath(new URL("../../../", import.meta.url));
const outDirs: string[] = [];

afterAll(() => {
  for (const dir of outDirs) rmSync(dir, { recursive: true, force: true });
});

describe.each([
  ["api", "ENCRYPTION_KEY, GITHUB_APP_ID, GITHUB_APP_PRIVATE_KEY, GITHUB_CLIENT_ID"],
  ["worker", "ENCRYPTION_KEY, GITHUB_APP_ID, GITHUB_APP_PRIVATE_KEY"],
])("the %s bundle", (app, expectedMissing) => {
  it("loads and stops at its configuration check with the names of what is missing", () => {
    const cwd = `${root}apps/${app}`;
    // Inside the app's directory, so its third-party dependencies resolve like they do in the image.
    const out = `dist-smoke-${process.pid}-${app}`;
    outDirs.push(`${cwd}/${out}`);
    execFileSync(
      process.execPath,
      [`${root}scripts/build-node.mjs`, "src/index.ts", `${out}/index.js`],
      {
        cwd,
        stdio: "ignore",
      },
    );

    const run = spawnSync(process.execPath, [`${out}/index.js`], {
      cwd,
      // No DATABASE_URL, no secrets: only what a start needs to be looked at.
      env: { PATH: process.env["PATH"] ?? "", NODE_ENV: "production" },
      encoding: "utf8",
      timeout: 20_000,
    });

    expect(run.status).toBe(1);
    const output = `${run.stdout}${run.stderr}`;
    expect(output).not.toContain("Dynamic require");
    expect(output).toContain("Missing required environment variables");
    expect(output).toContain(expectedMissing);
    // JSON logs in production, and the message names variables, never values.
    expect(JSON.parse(output.trim().split("\n")[0]!)).toMatchObject({ level: "error", app });
  });
});
