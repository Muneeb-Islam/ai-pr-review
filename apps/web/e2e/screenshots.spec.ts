// The screenshots in the README and docs/user-guide.md, taken from the seeded demo installation:
//
//   SCREENSHOTS=1 npm run e2e -w @ai-pr-review/web -- screenshots
//
// Skipped in a normal run. The demo data is fictional (packages/db/src/seed.ts); nothing here is a real repository.
import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { expect, test, type Page } from "@playwright/test";
import { readFileSync } from "node:fs";
import { ROOT, STATE_FILE } from "./support/env";
import type { SeedState } from "./support/globalSetup";

test.skip(!process.env["SCREENSHOTS"], "set SCREENSHOTS=1 to refresh docs/screenshots");

const OUT = resolve(ROOT, "docs/screenshots");
mkdirSync(OUT, { recursive: true });

test.use({ viewport: { width: 1280, height: 820 }, colorScheme: "light" });

async function shoot(page: Page, name: string): Promise<void> {
  // Let live indicators and charts settle, and keep the clock out of the picture.
  await page.waitForLoadState("networkidle");
  await page.screenshot({ path: resolve(OUT, `${name}.png`), animations: "disabled" });
}

test("runs, live", async ({ page }) => {
  await page.goto("/runs");
  await expect(page.getByRole("heading", { name: /In progress/ })).toBeVisible();
  await shoot(page, "runs");
});

test("run detail", async ({ page }) => {
  await page.goto("/runs?status=completed");
  await page
    .getByRole("link", { name: /demo-org\/api/ })
    .first()
    .click();
  await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
  await shoot(page, "run-detail");
});

test("findings", async ({ page }) => {
  await page.goto("/findings");
  await expect(
    page.getByRole("list", { name: "Findings" }).getByRole("listitem").first(),
  ).toBeVisible();
  await shoot(page, "findings");
});

test("analytics", async ({ page }) => {
  await page.goto("/analytics");
  await expect(page.getByRole("heading", { name: "Analytics", level: 1 })).toBeVisible();
  await shoot(page, "analytics");
});

test("repository settings", async ({ page }) => {
  const seed = JSON.parse(readFileSync(STATE_FILE, "utf8")) as SeedState;
  await page.goto(`/repos/${seed.repos.api}/settings`);
  await expect(page.getByRole("heading", { level: 1 })).toContainText("demo-org/api settings");
  await shoot(page, "settings");
});
