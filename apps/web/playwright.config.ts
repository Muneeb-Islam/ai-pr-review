// Browser tests (`npm run e2e -w @ai-pr-review/web`): a real api with the seeded demo data (PostgreSQL and Redis
// from .env, see `npm run db:up`), the Vite dev server and a real browser. The demo installation is reloaded
// before the run. Set E2E_BROWSER_CHANNEL=msedge (or chrome) to use an installed browser instead of Playwright's.
import { defineConfig } from "@playwright/test";
import { API_URL, apiEnv, AUTH_FILE, ROOT, WEB_PORT, WEB_URL } from "./e2e/support/env";

const channel = process.env["E2E_BROWSER_CHANNEL"];

export default defineConfig({
  testDir: "./e2e",
  globalSetup: "./e2e/support/globalSetup.ts",
  timeout: 30_000,
  expect: { timeout: 5_000 },
  // One database, one demo installation: the tests share it, so they run one after another.
  fullyParallel: false,
  workers: 1,
  retries: process.env["CI"] ? 1 : 0,
  reporter: process.env["CI"] ? [["github"], ["list"]] : "list",
  use: {
    baseURL: WEB_URL,
    storageState: AUTH_FILE,
    ...(channel ? { channel } : {}),
    trace: "retain-on-failure",
  },
  webServer: [
    {
      command: "npx tsx apps/api/src/index.ts",
      cwd: ROOT,
      url: `${API_URL}/healthz`,
      env: apiEnv(),
      reuseExistingServer: false,
      timeout: 60_000,
    },
    {
      command: "npm run dev -w @ai-pr-review/web",
      cwd: ROOT,
      url: WEB_URL,
      env: { API_URL, WEB_PORT: String(WEB_PORT) },
      reuseExistingServer: false,
      timeout: 60_000,
    },
  ],
});
