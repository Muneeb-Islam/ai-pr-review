// PL-14 and AC-16 in a real browser: a run appears as pending and moves to running and completed without a page
// refresh, within about five seconds of each change. The test plays the part of the api and the worker: it
// writes the run to PostgreSQL and announces it on Redis exactly as they do.
import { createRun, createDb } from "@ai-pr-review/db";
import { claimRun, finishClaimedRun, saveRunResults } from "@ai-pr-review/db/system";
import { createRedisConnection, RedisRunSignals } from "@ai-pr-review/queue";
import { expect, test } from "@playwright/test";
import { readFileSync } from "node:fs";
import type { SeedState } from "./support/globalSetup";
import { e2eDatabaseUrl, requireEnv, STATE_FILE } from "./support/env";

const seed = (): SeedState => JSON.parse(readFileSync(STATE_FILE, "utf8")) as SeedState;
const WITHIN = { timeout: 5_000 };

test("a new pull request appears as pending and updates live to running and completed", async ({
  page,
}) => {
  const state = seed();
  const handle = createDb(e2eDatabaseUrl(), { max: 2 });
  const redis = createRedisConnection(requireEnv("REDIS_URL"), "producer");
  const signals = new RedisRunSignals(redis);
  const prNumber = 9_000 + Math.floor(Math.random() * 900);

  try {
    await page.goto("/runs");
    // The live connection is open before anything happens.
    await expect(page.getByText("Live", { exact: true })).toBeVisible();
    const pinned = page.getByRole("list", { name: "Runs in progress" });
    await expect(pinned).toBeVisible();
    await expect(page.getByText(`#${prNumber}`)).toHaveCount(0);

    // A webhook arrives: the api records a queued run and announces it.
    const run = await createRun(handle.db, state.installationId, {
      repoId: state.repos.api,
      prNumber,
      headSha: "c".repeat(40),
      baseSha: "d".repeat(40),
      baseRef: "main",
      trigger: "pull_request",
      triggeredBy: "e2e-bot",
    });
    const announce = (status: "queued" | "running" | "completed") =>
      signals.publishUpdated({
        runId: run.id,
        installationId: state.installationId,
        repoId: state.repos.api,
        status,
      });
    await announce("queued");

    const row = pinned.getByRole("listitem").filter({ hasText: `#${prNumber}` });
    await expect(row).toBeVisible(WITHIN);
    await expect(row.getByText("Queued")).toBeVisible();
    await expect(row).toHaveAttribute("data-active", "true");

    // A worker picks it up.
    const claimed = await claimRun(handle.db, run.id);
    expect(claimed).toBeDefined();
    await announce("running");
    await expect(row.getByText("Running")).toBeVisible(WITHIN);
    await expect(row.getByText("Queued")).toHaveCount(0);

    // Opening it while it runs shows the same status, and it changes under the viewer's eyes.
    await row.getByRole("link").first().click();
    await expect(page.getByRole("heading", { level: 1 })).toContainText(`#${prNumber}`);
    await expect(page.getByRole("list", { name: "Run timeline" })).toContainText("Running for");

    // The review ends.
    await saveRunResults(handle.db, run.id, claimed!.attempts, {
      agentRuns: [
        {
          agent: "code_review",
          status: "ok",
          startedAt: new Date(),
          durationMs: 4_200,
          inputTokens: 900,
          outputTokens: 120,
          retries: 0,
          warnings: [],
        },
      ],
      findings: [],
      warnings: [],
      usage: { inputTokens: 900, outputTokens: 120 },
      skippedFiles: [],
    });
    await finishClaimedRun(handle.db, run.id, claimed!.attempts, "completed");
    await announce("completed");

    await expect(page.getByRole("list", { name: "Run timeline" })).toContainText(
      "Completed",
      WITHIN,
    );
    await expect(page.getByRole("table", { name: /agents that ran/i })).toContainText(
      "Code Review",
      WITHIN,
    );
    await expect(page.getByText("The review found nothing to report.")).toBeVisible();

    // Back on the list, it has left the in-progress section and is in the history as completed.
    await page.getByRole("link", { name: /all runs/i }).click();
    const history = page.getByRole("list", { name: "Runs", exact: true });
    await expect(
      history
        .getByRole("listitem")
        .filter({ hasText: `#${prNumber}` })
        .getByText("Completed"),
    ).toBeVisible(WITHIN);
  } finally {
    redis.disconnect();
    await handle.close();
  }
});

test("falls back to polling when the live connection cannot be opened", async ({ page }) => {
  // The event stream is refused (as a proxy that blocks it would): the dashboard says so and keeps working.
  await page.route("**/api/events", (route) => route.abort());
  await page.goto("/repos");
  await expect(page.getByText(/refreshing every few seconds/i)).toBeVisible(WITHIN);
  await expect(page.getByRole("list", { name: "Repositories" })).toBeVisible();

  const state = seed();
  const handle = createDb(e2eDatabaseUrl(), { max: 2 });
  try {
    const run = await createRun(handle.db, state.installationId, {
      repoId: state.repos.docs,
      prNumber: 9_999,
      headSha: "e".repeat(40),
      baseSha: "f".repeat(40),
      baseRef: "master",
      trigger: "pull_request",
      skip: { reason: "Polling test: skipped on purpose" },
    });
    // No event arrives; the next poll (every five seconds) finds it.
    const docs = page.getByRole("listitem").filter({ hasText: "demo-org/docs" });
    await expect(docs).toContainText("#9999", { timeout: 12_000 });
    expect(run.id).toBeTruthy();
  } finally {
    await handle.close();
  }
});
