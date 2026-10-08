// The dashboard against the seeded demo installation (packages/db/src/seed.ts): sign in with a session, see the
// repositories and runs, filter, page, and open a run.
import { expect, test } from "@playwright/test";
import { SIGNOUT_AUTH_FILE } from "./support/env";

test.describe("signed in", () => {
  test("lists the repositories with their last run", async ({ page }) => {
    await page.goto("/repos");
    await expect(page).toHaveTitle(/Repositories/);
    const list = page.getByRole("list", { name: "Repositories" });
    await expect(list.getByRole("listitem")).toHaveCount(3);

    const api = list.getByRole("listitem").filter({ hasText: "demo-org/api" });
    await expect(api.getByText("Private")).toBeVisible();
    await expect(api.getByText("Enabled")).toBeVisible();
    // The newest run of demo-org/api is the queued one.
    await expect(api.getByText("Queued")).toBeVisible();

    const docs = list.getByRole("listitem").filter({ hasText: "demo-org/docs" });
    await expect(docs.getByText("Skipped")).toBeVisible();
    await expect(docs.getByText("Public")).toBeVisible();
  });

  test("opens a repository's runs from the repository list", async ({ page }) => {
    await page.goto("/repos");
    await page.getByRole("link", { name: /demo-org\/docs/ }).click();
    await expect(page).toHaveURL(/\/runs\?repo=/);
    await expect(page.getByLabel("Repository")).toHaveValue(/.+/);
    await expect(page.getByRole("link", { name: /demo-org\/docs #300/ })).toBeVisible();
    await expect(page.getByRole("link", { name: /demo-org\/api/ })).toHaveCount(0);
  });

  test("pins runs in flight above the history and pages through the rest", async ({ page }) => {
    await page.goto("/runs");
    const pinned = page.getByRole("list", { name: "Runs in progress" });
    await expect(page.getByRole("heading", { name: "In progress (2)" })).toBeVisible();
    await expect(pinned.getByRole("listitem")).toHaveCount(2);
    await expect(pinned.getByText("Running")).toBeVisible();
    await expect(pinned.getByText("Queued")).toBeVisible();

    const history = page.getByRole("list", { name: "Runs", exact: true });
    const first = await history.getByRole("listitem").count();
    expect(first).toBeGreaterThan(0);
    await page.getByRole("button", { name: "Load more" }).click();
    await expect.poll(() => history.getByRole("listitem").count()).toBeGreaterThan(first);
  });

  test("filters by repository and status, and keeps the filters in the address", async ({
    page,
  }) => {
    await page.goto("/runs");
    await page.getByLabel("Repository").selectOption({ label: "demo-org/web" });
    await expect(page).toHaveURL(/repo=/);
    await expect(page.getByRole("link", { name: /demo-org\/api/ })).toHaveCount(0);

    await page.getByLabel("Status").selectOption("failed");
    await expect(page).toHaveURL(/status=failed/);
    const rows = page.getByRole("list", { name: "Runs", exact: true }).getByRole("listitem");
    await expect(rows.first()).toContainText("Failed");
    for (const row of await rows.all()) await expect(row).toContainText("demo-org/web");

    await page.getByRole("button", { name: "Clear filters" }).first().click();
    await expect(page).toHaveURL(/\/runs$/);
  });

  test("the pending view shows queued and running runs across repositories", async ({ page }) => {
    await page.goto("/runs");
    await page.getByRole("link", { name: "Pending" }).click();
    await expect(page).toHaveURL(/view=pending/);
    await expect(page.getByRole("heading", { name: "Pending runs", level: 1 })).toBeVisible();
    const rows = page.getByRole("list", { name: "Runs", exact: true }).getByRole("listitem");
    await expect(rows).toHaveCount(2);
    for (const row of await rows.all()) await expect(row).toContainText(/Queued|Running/);
  });

  test("opens a run: timeline, agents, findings, skipped files and usage", async ({ page }) => {
    await page.goto("/runs?status=completed");
    // The newest completed run of demo-org/api is a re-run of the reviewed one.
    await page
      .getByRole("link", { name: /demo-org\/api #100/ })
      .first()
      .click();
    await expect(page.getByRole("heading", { level: 1 })).toContainText("demo-org/api #100");
    await expect(page.getByRole("list", { name: "Run timeline" })).toContainText("Queued");

    await page.getByRole("link", { name: "Earlier run" }).click();
    await expect(page.getByRole("heading", { name: "Findings (3)" })).toBeVisible();
    const findings = page
      .getByRole("heading", { name: "Findings (3)" })
      .locator("xpath=ancestor::section");
    await expect(findings.getByText("SQL built from request input")).toBeVisible();
    await expect(findings.getByText("Critical", { exact: true })).toBeVisible();
    await expect(page.getByRole("table", { name: /agents that ran/i })).toContainText("Security");

    // Security (Phase 12): the overall status, the call-out, and a category filter over the findings.
    const security = page.getByTestId("security-panel");
    await expect(security).toContainText("Attention needed: 1 critical security finding.");
    await expect(security).toContainText("SQL built from request input");
    await expect(security).toContainText("not a replacement for SAST or dependency scanning");
    const filter = page.getByRole("group", { name: "Filter findings by category" });
    await filter.getByRole("button", { name: "Security (1)", exact: true }).click();
    await expect(findings.getByRole("listitem")).toHaveCount(1);
    await expect(page).toHaveURL(/category=security/);
    await filter.getByRole("button", { name: "All (3)", exact: true }).click();
    await expect(findings.getByRole("listitem")).toHaveCount(3);
    await expect(page.getByText(/Not shown: 1 below the thresholds, 1 style only/)).toBeVisible();

    // Measured coverage (Phase 11): the number, the report's source and the lines that never ran.
    await expect(page.getByTestId("coverage-percent")).toHaveText("72%");
    const coverage = page.getByRole("table", { name: /coverage of the changed lines/i });
    await expect(coverage).toContainText("src/module1.ts");
    await expect(coverage).toContainText("14–17, 30–31");
    await expect(coverage).toContainText("Not in the report, so its coverage is unknown");

    // A finding opens to its evidence and advice.
    await findings.getByText("SQL built from request input").click();
    await expect(page.getByText("value.name is read before the null check").first()).toBeVisible();
    await expect(page.getByRole("link", { name: /demo-org\/api#100/ })).toHaveAttribute(
      "href",
      "https://github.com/demo-org/api/pull/100",
    );
  });

  test("says why coverage could not be measured", async ({ page }) => {
    await page.goto("/runs?status=partial");
    await page
      .getByRole("link", { name: /demo-org\/api #101/ })
      .first()
      .click();
    await expect(page.getByText("Coverage could not be measured.")).toBeVisible();
    await expect(page.getByText(/uploaded an artifact named "coverage"/)).toBeVisible();
    await expect(page.getByTestId("coverage-percent")).toHaveCount(0);
  });

  test("shows 'not found' for a run that does not exist", async ({ page }) => {
    await page.goto("/runs/00000000-0000-4000-8000-000000000000");
    await expect(page.getByRole("heading", { name: "Run not found" })).toBeVisible();
  });

  test.describe("with its own session", () => {
    // Signing out ends the session for good, so this test must not share the one the others use.
    test.use({ storageState: SIGNOUT_AUTH_FILE });

    test("signs out from the account menu", async ({ page }) => {
      await page.goto("/repos");
      await page.getByRole("button", { name: /account menu for demo-dev/i }).click();
      await page.getByRole("menuitem", { name: "Sign out" }).click();
      await expect(page).toHaveURL(/\/login/);
      await expect(page.getByRole("link", { name: /sign in with github/i })).toBeVisible();
      // The session is really gone: the dashboard asks to sign in again.
      await page.goto("/runs");
      await expect(page).toHaveURL(/\/login/);
    });
  });
});

test.describe("signed out", () => {
  test.use({ storageState: { cookies: [], origins: [] } });

  test("is sent to the login page and back to where it wanted to go", async ({ page }) => {
    await page.goto("/runs?status=failed");
    await expect(page).toHaveURL(/\/login/);
    const signIn = page.getByRole("link", { name: /sign in with github/i });
    await expect(signIn).toHaveAttribute("href", /return_to=%2Fruns%3Fstatus%3Dfailed$/);
  });

  test("the sign-in link goes to GitHub with a state and a PKCE challenge", async ({ request }) => {
    const response = await request.get("http://127.0.0.1:3100/auth/github/login", {
      maxRedirects: 0,
    });
    expect(response.status()).toBe(302);
    const location = new URL(response.headers()["location"]!);
    expect(location.origin + location.pathname).toBe("https://github.com/login/oauth/authorize");
    expect(location.searchParams.get("state")).toBeTruthy();
    expect(location.searchParams.get("code_challenge_method")).toBe("S256");
  });
});
