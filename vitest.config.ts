import { defineConfig } from "vitest/config";

// Workspace packages export their TypeScript source, so no build is needed to test. The dashboard's tests run
// in a simulated browser (jsdom); everything else runs in plain Node.
export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: "node",
          environment: "node",
          include: ["{apps,packages}/*/src/**/*.test.{ts,tsx}"],
          exclude: ["apps/web/**", "**/node_modules/**"],
          // Many files create a PostgreSQL database inside a test; with all projects running at once that can take
          // longer than the default 5 s on a busy machine or a CI runner.
          testTimeout: 30_000,
          hookTimeout: 60_000,
        },
      },
      {
        // Phase 16: the acceptance suite. It drives the real api, worker and publisher together, so it lives outside
        // any one workspace (docs/acceptance.md).
        test: {
          name: "acceptance",
          environment: "node",
          include: ["acceptance/**/*.test.ts"],
          testTimeout: 30_000,
          hookTimeout: 60_000,
        },
      },
      {
        test: {
          name: "web",
          environment: "jsdom",
          include: ["apps/web/src/**/*.test.{ts,tsx}"],
          setupFiles: ["apps/web/src/test/setup.ts"],
        },
      },
    ],
  },
});
