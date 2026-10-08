// Phase 14 in a real browser against the seeded demo installation: the findings explorer, feedback that moves the
// analytics (AC-19), the history of a pull request, settings and keys, re-run and cancel (AC-21), the audit view,
// CSV export and the retention notice. The api and PostgreSQL are real; GitHub is not involved, so the two calls
// that would reach it (the provider connection test and the re-run's pull request lookup) are answered in the
// browser, and everything else goes through the real api.
import { createDb, createRun } from "@ai-pr-review/db";
import { expect, test } from "@playwright/test";
import { readFileSync } from "node:fs";
import { e2eDatabaseUrl, STATE_FILE } from "./support/env";
import type { SeedState } from "./support/globalSetup";

const seed = (): SeedState => JSON.parse(readFileSync(STATE_FILE, "utf8")) as SeedState;

test.describe("findings explorer", () => {
  test("filters by severity, opens a finding and links to its GitHub comment", async ({ page }) => {
    await page.goto("/findings");
    await expect(page.getByRole("heading", { name: "Findings", level: 1 })).toBeVisible();
    const list = page.getByRole("list", { name: "Findings" });
    await expect(list.getByRole("listitem").first()).toBeVisible();

    await page.getByLabel("Severity").selectOption("critical");
    await expect(page).toHaveURL(/severity=critical/);
    await expect(list.getByRole("listitem")).toHaveCount(1);
    await expect(list).toContainText("SQL built from request input");
    await expect(list).toContainText("Security");

    await list.getByRole("link", { name: "Details" }).click();
    await expect(
      page.getByRole("heading", { name: "SQL built from request input", level: 1 }),
    ).toBeVisible();
    await expect(page.getByText("value.name is read before the null check")).toBeVisible();
    await expect(page.getByRole("link", { name: /Open the comment on GitHub/ })).toHaveAttribute(
      "href",
      /^https:\/\/github\.com\/demo-org\/api\/pull\/100#discussion_r\d+$/,
    );
    await expect(page.getByRole("link", { name: "History of this pull request" })).toBeVisible();
  });

  test("shows findings the review dropped only when asked, and cannot rate them", async ({
    page,
  }) => {
    await page.goto("/findings?repo=" + seed().repos.api);
    await expect(page.getByRole("list", { name: "Findings" })).not.toContainText("Not reported");
    await page.getByLabel("Status").selectOption("suppressed");
    const list = page.getByRole("list", { name: "Findings" });
    await expect(list.getByRole("listitem")).toHaveCount(2);
    await expect(list).toContainText("Not reported: below the thresholds");
    await expect(list.getByRole("button", { name: "Useful" })).toHaveCount(0);
  });

  test("searches by file path", async ({ page }) => {
    await page.goto("/findings");
    await page.getByLabel("File path contains").fill("module1");
    await expect(page).toHaveURL(/path=module1/);
    const list = page.getByRole("list", { name: "Findings" });
    for (const item of await list.getByRole("listitem").all()) {
      await expect(item).toContainText("src/module1.ts");
    }
  });
});

test.describe("feedback and analytics (AC-19)", () => {
  test("a vote changes the actionable rate", async ({ page }) => {
    const api = seed().repos.api;
    await page.goto(`/analytics?repo=${api}`);
    const tile = page.getByTestId("tile-actionable");
    // The seed has two votes on posted findings of this repository: one useful, one false positive.
    await expect(tile).toContainText("50%");
    await expect(tile).toContainText("1 of 2 votes");
    await expect(tile).toContainText("Small sample");
    await expect(page.getByTestId("target-actionable_rate")).toContainText("Not met");

    // Rate a finding nobody has rated yet.
    await page.goto(`/findings?repo=${api}&status=posted`);
    const card = page.locator("[data-finding]").filter({ hasText: "Demo finding 6" });
    await card.getByRole("button", { name: "Useful" }).click();
    await expect(card.getByRole("button", { name: "Useful" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );

    await page.goto(`/analytics?repo=${api}`);
    await expect(tile).toContainText("67%");
    await expect(tile).toContainText("2 of 3 votes");
    await expect(page.getByTestId("target-actionable_rate")).toContainText("Not met");

    // Changing the verdict moves it again; the vote is still one.
    await page.goto(`/findings?repo=${api}&status=posted`);
    await card.getByRole("button", { name: "False positive" }).click();
    await expect(card.getByRole("button", { name: "False positive" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    await page.goto(`/analytics?repo=${api}`);
    await expect(tile).toContainText("1 of 3 votes");
    await expect(page.getByTestId("tile-false-positive")).toContainText("67%");
  });

  test("shows every metric with its target, and the charts with their tables", async ({ page }) => {
    await page.goto("/analytics");
    for (const metric of [
      "completion_rate",
      "median_duration_ms",
      "actionable_rate",
      "false_positive_rate",
      "duplicate_rate",
      "summary_coverage",
    ]) {
      await expect(page.getByTestId(`target-${metric}`)).toBeVisible();
    }
    await expect(page.getByTestId("tile-reviews")).toContainText(/\d+/);
    await expect(page.getByTestId("cost")).toBeVisible();

    const reviews = page.getByRole("region", { name: "Reviews over time" });
    await expect(reviews.getByRole("list", { name: "Legend" })).toContainText("Completed");
    await reviews.getByText("View as a table").click();
    await expect(
      reviews.getByRole("table", { name: "Reviews per period by outcome" }),
    ).toBeVisible();
    await expect(page.getByRole("region", { name: "Severity mix" })).toBeVisible();
    await expect(page.getByRole("region", { name: "Duration trend" })).toBeVisible();

    // A longer period is another request, and it is in the address.
    await page.getByLabel("Period").selectOption("90");
    await expect(page).toHaveURL(/days=90/);
    await expect(page.getByTestId("tile-reviews")).toBeVisible();
  });
});

test("the history of a pull request shows what changed between reviews", async ({ page }) => {
  await page.goto(`/repos/${seed().repos.api}/pulls/100`);
  await expect(page.getByRole("heading", { level: 1 })).toContainText("demo-org/api #100 history");
  const runs = page.getByRole("list", { name: /Runs of this pull request, oldest first/ });
  await expect(runs.locator("> li")).toHaveCount(3);
  // The superseded run reviewed nothing; the first review reported three findings; the re-run found one of
  // them again and its agents could not look at the other two.
  await expect(runs.locator("> li").nth(0)).toContainText("did not produce a review");
  await expect(runs.locator("> li").nth(1).getByTestId("change-summary")).toHaveText(
    /3 new \(first review\)/,
  );
  await expect(runs.locator("> li").nth(2).getByTestId("change-summary")).toHaveText(
    "1 still applicable · 2 not evaluated",
  );
});

test.describe("settings and provider keys", () => {
  test("an admin changes a setting and it is kept", async ({ page }) => {
    const api = seed().repos.api;
    await page.goto(`/repos/${api}/settings`);
    await expect(page.getByRole("heading", { level: 1 })).toContainText("demo-org/api settings");
    // GitHub is not reachable from the test stack, so the repository file cannot be read.
    await expect(page.getByTestId("repo-file-status")).toHaveAttribute(
      "data-status",
      /unavailable|absent/,
    );
    await expect(page.getByLabel("Provider", { exact: true })).toHaveValue("deepseek");
    await expect(page.getByTestId("provider-notice")).toContainText("China-based company");

    const mode = page.getByLabel("Enforcement mode");
    await expect(mode).toHaveValue("warn");
    await mode.selectOption("comment_only");
    await page.getByLabel("Minimum confidence (0 to 1)").fill("0.7");
    await page.getByRole("button", { name: "Save settings" }).click();
    await expect(page.getByText("Settings saved.")).toBeVisible();

    await page.reload();
    await expect(page.getByLabel("Enforcement mode")).toHaveValue("comment_only");
    await expect(page.getByLabel("Minimum confidence (0 to 1)")).toHaveValue("0.7");
  });

  test("a value the schema refuses is explained and nothing is saved", async ({ page }) => {
    await page.goto(`/repos/${seed().repos.api}/settings`);
    await page.getByLabel("Minimum confidence (0 to 1)").fill("3");
    await page.getByRole("button", { name: "Save settings" }).click();
    await expect(page.getByRole("alert")).toContainText("These settings cannot be saved yet");
    await expect(page.getByLabel("Minimum confidence (0 to 1)")).toHaveAttribute(
      "aria-invalid",
      "true",
    );
  });

  test("leaving with unsaved changes asks first", async ({ page }) => {
    await page.goto(`/repos/${seed().repos.api}/settings`);
    await page.getByLabel("Enforcement mode").selectOption("fail_on_threshold");
    await page
      .getByRole("navigation", { name: "Main" })
      .getByRole("link", { name: "Runs" })
      .click();
    const dialog = page.getByRole("alertdialog", { name: "Leave without saving?" });
    await expect(dialog).toBeVisible();
    await dialog.getByRole("button", { name: "Stay on this page" }).click();
    await expect(page).toHaveURL(/\/settings$/);
    await page.getByRole("button", { name: "Discard changes" }).click();
  });

  test("an admin adds a key, tests it, sees only its last four characters, and removes it", async ({
    page,
  }) => {
    // The connection test would call the provider; answer it here.
    await page.route("**/api/repos/*/credentials/test", (route) =>
      route.fulfill({ json: { ok: true, message: "The provider accepted the key." } }),
    );
    await page.goto(`/repos/${seed().repos.api}/settings`);
    const row = page.locator("li[data-provider='openai']");
    await expect(row).toContainText("No key set");
    await row.getByRole("button", { name: "Add key" }).click();
    await row.getByLabel("API key").fill("sk-e2e-0123456789wxyz");
    await row.getByRole("button", { name: "Test connection" }).click();
    await expect(row).toContainText("Connected: The provider accepted the key.");
    await row.getByRole("button", { name: "Save key" }).click();

    await expect(row).toContainText("Key ending in wxyz");
    await expect(page.locator("body")).not.toContainText("sk-e2e-0123456789wxyz");
    await expect(row.getByLabel("API key")).toHaveCount(0);
    // Not even a reload brings the key back.
    await page.reload();
    await expect(page.locator("li[data-provider='openai']")).toContainText("Key ending in wxyz");
    await expect(page.locator("body")).not.toContainText("sk-e2e-0123456789wxyz");

    await page
      .locator("li[data-provider='openai']")
      .getByRole("button", { name: "Remove key" })
      .click();
    await page.getByRole("alertdialog").getByRole("button", { name: "Remove key" }).click();
    await expect(page.locator("li[data-provider='openai']")).toContainText("No key set");
  });
});

test.describe("re-run, cancel and the audit view", () => {
  test("re-run asks first, then follows the new run (AC-21)", async ({ page }) => {
    // The api would ask GitHub for the pull request; answer with another seeded run as the new one.
    const failed = await page.request.get("/api/runs?status=failed&limit=1");
    const target = (await failed.json()).items[0] as { id: string };
    const asked: string[] = [];
    await page.route("**/api/runs/*/rerun", (route) => {
      asked.push(route.request().url());
      void page.request.get(`/api/runs?status=failed&limit=1`).then(async (r) => {
        const run = ((await r.json()).items as unknown[])[0];
        await route.fulfill({ status: 202, json: { run, created: true } });
      });
    });

    await page.goto("/runs?status=completed");
    await page
      .getByRole("link", { name: /demo-org\/api #100/ })
      .first()
      .click();
    await page.getByRole("button", { name: "Re-run review" }).click();
    const dialog = page.getByRole("alertdialog", { name: "Re-run this review?" });
    await expect(dialog).toBeVisible();
    expect(asked).toHaveLength(0);
    await dialog.getByRole("button", { name: "Re-run" }).click();
    await expect(page).toHaveURL(new RegExp(`/runs/${target.id}$`));
    expect(asked).toHaveLength(1);
  });

  test("cancels a queued run for real and records it", async ({ page }) => {
    const state = seed();
    const handle = createDb(e2eDatabaseUrl(), { max: 2 });
    let runId: string;
    try {
      const run = await createRun(handle.db, state.installationId, {
        repoId: state.repos.web,
        prNumber: 7_000 + Math.floor(Math.random() * 900),
        headSha: "e".repeat(40),
        baseSha: "f".repeat(40),
        baseRef: "main",
        trigger: "pull_request",
        triggeredBy: "e2e-bot",
      });
      runId = run.id;
    } finally {
      await handle.close();
    }

    await page.goto(`/runs/${runId}`);
    await expect(page.getByRole("button", { name: "Cancel run" })).toBeEnabled();
    await page.getByRole("button", { name: "Cancel run" }).click();
    const dialog = page.getByRole("alertdialog", { name: "Cancel this run?" });
    await expect(dialog).toBeVisible();
    await dialog.getByRole("button", { name: "Cancel run" }).click();
    await expect(page.getByText("Cancelled", { exact: true }).first()).toBeVisible();
    await expect(page.getByRole("button", { name: "Cancel run" })).toBeDisabled();

    await page.goto(`/installations/${state.installationId}/audit`);
    const table = page.getByRole("table", { name: /Audit log entries/ });
    await expect(table.getByRole("row").nth(1)).toContainText("Cancelled a review");
    await expect(table.getByRole("row").nth(1)).toContainText("demo-dev");
  });

  test("the audit log lists settings and key changes by name, filterable by action", async ({
    page,
  }) => {
    await page.goto(`/installations/${seed().installationId}/audit`);
    const table = page.getByRole("table", { name: /Audit log entries/ });
    await expect(table).toContainText("Changed repository settings");
    await expect(table).toContainText("Set a provider key");
    await expect(table).toContainText("Removed a provider key");
    // Names of what changed, never a key.
    await expect(table).toContainText("provider: openai");
    await expect(table).not.toContainText("sk-e2e");

    await page.getByLabel("Action").selectOption("credential.put");
    await expect(page).toHaveURL(/action=credential\.put/);
    for (const row of (await table.getByRole("row").all()).slice(1)) {
      await expect(row).toContainText("Set a provider key");
    }
  });
});

test.describe("export, retention and usage", () => {
  test("an admin downloads runs and findings as CSV", async ({ page }) => {
    const api = seed().repos.api;
    await page.goto(`/repos/${api}/settings`);
    const download = page.waitForEvent("download");
    await page.getByRole("link", { name: "Download CSV" }).click();
    const file = await download;
    expect(file.suggestedFilename()).toMatch(/^demo-org-api-runs-\d{4}-\d{2}-\d{2}\.csv$/);

    const findings = await page.request.get(`/api/repos/${api}/export?kind=findings`);
    expect(findings.status()).toBe(200);
    expect(findings.headers()["content-type"]).toContain("text/csv");
    const text = await findings.text();
    expect(text).toContain("finding_id,run_id,pr_number");
    expect(text).toContain("SQL built from request input");
    expect(text).toContain(",suppressed,below_threshold,");
  });

  test("the installation page shows usage against the daily limits and the retention window", async ({
    page,
  }) => {
    await page.goto(`/installations/${seed().installationId}/settings`);
    await expect(page.getByRole("heading", { level: 1 })).toContainText(
      "demo-org: installation defaults",
    );
    await expect(page.getByRole("progressbar", { name: /Reviews today/ })).toBeVisible();
    await expect(page.getByRole("progressbar", { name: /Tokens today/ })).toBeVisible();
    await expect(page.getByTestId("retention")).toContainText("kept for 90 days");
    await expect(page.getByRole("link", { name: "Audit log" })).toBeVisible();
  });
});
