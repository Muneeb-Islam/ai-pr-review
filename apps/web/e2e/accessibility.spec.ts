// Basic accessibility and responsiveness in a real browser: automated WCAG checks (including colour contrast,
// which jsdom cannot measure) in both themes, and no sideways scrolling at phone width.
import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";
import { readFileSync } from "node:fs";
import { STATE_FILE } from "./support/env";
import type { SeedState } from "./support/globalSetup";

const seed = JSON.parse(readFileSync(STATE_FILE, "utf8")) as SeedState;

const TAGS = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"];

async function violations(page: Page) {
  const results = await new AxeBuilder({ page }).withTags(TAGS).analyze();
  return results.violations.map((v) => ({
    rule: v.id,
    impact: v.impact,
    targets: v.nodes.slice(0, 3).map((n) => n.target.join(" ")),
  }));
}

/** Waits for the page to have its content (not a loading state) before it is measured. */
async function ready(page: Page, path: string) {
  await page.goto(path);
  await expect(page.getByRole("status")).toHaveCount(0);
}

const PAGES: Array<[string, string]> = [
  ["repositories", "/repos"],
  ["runs", "/runs"],
  ["pending runs", "/runs?view=pending"],
  ["findings", "/findings"],
  ["analytics", "/analytics"],
  ["history of a pull request", `/repos/${seed.repos.api}/pulls/100`],
  ["repository settings", `/repos/${seed.repos.api}/settings`],
  ["installation defaults", `/installations/${seed.installationId}/settings`],
  ["audit log", `/installations/${seed.installationId}/audit`],
];

for (const scheme of ["light", "dark"] as const) {
  test.describe(`${scheme} theme`, () => {
    test.use({ colorScheme: scheme });

    for (const [name, path] of PAGES) {
      test(`${name} has no accessibility violations`, async ({ page }) => {
        await ready(page, path);
        await expect(page.locator("html")).toHaveClass(
          scheme === "dark" ? /dark/ : /^(?!.*dark).*$/,
        );
        expect(await violations(page)).toEqual([]);
      });
    }

    test("a run's detail has no accessibility violations", async ({ page }) => {
      await ready(page, "/runs?status=completed");
      await page
        .getByRole("link", { name: /demo-org\/api #100/ })
        .first()
        .click();
      await page.getByRole("link", { name: "Earlier run" }).click();
      await expect(page.getByRole("heading", { name: "Findings (3)" })).toBeVisible();
      // Findings are folded; open one so its content is checked too.
      await page.locator("li[data-category='security'] summary").click();
      expect(await violations(page)).toEqual([]);
    });

    test("the login page has no accessibility violations", async ({ browser }) => {
      const context = await browser.newContext({
        colorScheme: scheme,
        storageState: { cookies: [], origins: [] },
      });
      const page = await context.newPage();
      await page.goto("/login");
      await expect(page.getByRole("link", { name: /sign in with github/i })).toBeVisible();
      expect(await violations(page)).toEqual([]);
      await context.close();
    });
  });
}

test.describe("phone width", () => {
  test.use({ viewport: { width: 375, height: 812 } });

  const noSidewaysScroll = async (page: Page) => {
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect(overflow).toBeLessThanOrEqual(0);
  };

  for (const [name, path] of PAGES) {
    test(`${name} fits the screen`, async ({ page }) => {
      await ready(page, path);
      await noSidewaysScroll(page);
    });
  }

  test("a run's detail fits the screen and the navigation is reachable", async ({ page }) => {
    await ready(page, "/runs?status=completed");
    await page
      .getByRole("link", { name: /demo-org\/api #100/ })
      .first()
      .click();
    await page.getByRole("link", { name: "Earlier run" }).click();
    await expect(page.getByRole("heading", { name: "Findings (3)" })).toBeVisible();
    await noSidewaysScroll(page);
    await page
      .getByRole("navigation", { name: "Main" })
      .getByRole("link", { name: "Runs" })
      .click();
    await expect(page).toHaveURL(/\/runs$/);
  });
});

test("every control in the filter form has a label", async ({ page }) => {
  await ready(page, "/runs");
  for (const label of ["Repository", "Status", "Base branch", "From", "To"]) {
    await expect(page.getByLabel(label, { exact: true })).toBeVisible();
  }
});

test("the theme toggle switches the page between light and dark", async ({ page }) => {
  await page.emulateMedia({ colorScheme: "light" });
  await ready(page, "/repos");
  const html = page.locator("html");
  await expect(html).not.toHaveClass(/dark/);
  await page.getByRole("button", { name: /^Theme: System/ }).click(); // -> light
  await page.getByRole("button", { name: /^Theme: Light/ }).click(); // -> dark
  await expect(html).toHaveClass(/dark/);
  await page.reload();
  await expect(html).toHaveClass(/dark/); // remembered
});
