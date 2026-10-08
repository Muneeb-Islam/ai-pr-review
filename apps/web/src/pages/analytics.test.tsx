// UI-07: the analytics page: each PRD metric with its target and sample size, and the charts with table views.
import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http } from "msw";
import { describe, expect, it } from "vitest";
import { niceMax } from "../components/charts/charts";
import { API, makeRepo } from "../test/fixtures";
import { makeSeries, makeSummary } from "../test/insightFixtures";
import { apiError, json, renderApp, signedInAs } from "../test/render";
import { server } from "../test/server";

function serve(summary = makeSummary(), series = makeSeries(), seen?: URL[]) {
  signedInAs();
  server.use(
    http.get(`${API}/api/repos`, () =>
      json({ items: [makeRepo({ id: "repo-1", full_name: "acme/api" })] }),
    ),
    http.get(`${API}/api/analytics/summary`, ({ request }) => {
      seen?.push(new URL(request.url));
      return json(summary);
    }),
    http.get(`${API}/api/analytics/timeseries`, ({ request }) => {
      seen?.push(new URL(request.url));
      return json(series);
    }),
  );
}

const tile = (id: string) => screen.findByTestId(`tile-${id}`);

describe("Analytics page", () => {
  it("shows each metric with its value, target, whether it is met and what it rests on", async () => {
    serve();
    renderApp("/analytics");

    const completion = await tile("completion");
    expect(within(completion).getByText("94%")).toBeVisible();
    expect(within(completion).getByText("36 finished reviews", { exact: false })).toBeVisible();
    // 34 of 36 is 94.4%, short of the 95% target.
    expect(within(completion).getByTestId("target-completion_rate")).toHaveAttribute(
      "data-state",
      "missed",
    );
    expect(within(completion).getByText(/Target: At least 95%/)).toBeVisible();
    expect(within(completion).getByText("Not met")).toBeVisible();

    const duration = await tile("duration");
    expect(within(duration).getByText("2 m 30 s")).toBeVisible();
    expect(within(duration).getByTestId("target-median_duration_ms")).toHaveAttribute(
      "data-state",
      "met",
    );

    const actionable = await tile("actionable");
    expect(within(actionable).getByText("75%")).toBeVisible();
    expect(within(actionable).getByText(/15 of 20 votes/)).toBeVisible();
    expect(within(actionable).getByTestId("target-actionable_rate")).toHaveAttribute(
      "data-state",
      "met",
    );

    const falsePositive = await tile("false-positive");
    expect(within(falsePositive).getByText("15%")).toBeVisible();
    expect(within(falsePositive).getByTestId("target-false_positive_rate")).toHaveAttribute(
      "data-state",
      "met",
    );

    const duplicates = await tile("duplicates");
    expect(within(duplicates).getByText("0%")).toBeVisible();
    expect(within(duplicates).getByText(/Under 2%/)).toBeVisible();

    const coverage = await tile("summary");
    expect(within(coverage).getByText("92%")).toBeVisible();
    expect(within(coverage).getByTestId("target-summary_coverage")).toHaveAttribute(
      "data-state",
      "met",
    );

    expect(within(await tile("reviews")).getByText("40")).toBeVisible();
    expect(within(await tile("findings")).getByText("17")).toBeVisible();
  });

  it("warns that a small sample says little, but still shows the rate", async () => {
    serve(
      makeSummary({
        feedback: {
          votes: 3,
          useful: 3,
          false_positive: 0,
          known: 0,
          rated_findings: 3,
          actionable_rate: 1,
          false_positive_rate: 0,
        },
      }),
    );
    renderApp("/analytics");
    const actionable = await tile("actionable");
    expect(within(actionable).getByText("100%")).toBeVisible();
    expect(within(actionable).getByText(/Small sample \(under 10\)/)).toBeVisible();
    expect(within(actionable).getByTestId("target-actionable_rate")).toHaveAttribute(
      "data-state",
      "met",
    );
    // Plenty of reviews, so the completion tile carries no warning.
    expect(within(await tile("completion")).queryByText(/Small sample/)).toBeNull();
  });

  it("does not judge what it cannot measure yet", async () => {
    serve(
      makeSummary({
        completion: { rate: null, sample: 0 },
        feedback: {
          votes: 0,
          useful: 0,
          false_positive: 0,
          known: 0,
          rated_findings: 0,
          actionable_rate: null,
          false_positive_rate: null,
        },
        duplicates: { runs_with_comments: 0, runs_with_duplicates: 0, rate: null },
      }),
    );
    renderApp("/analytics");
    const actionable = await tile("actionable");
    expect(within(actionable).getByText("–")).toBeVisible();
    expect(within(actionable).getByTestId("target-actionable_rate")).toHaveAttribute(
      "data-state",
      "no_data",
    );
    expect(within(actionable).getByText("No data yet")).toBeVisible();
  });

  it("states the cost as an estimate, and says when there is none", async () => {
    serve();
    const { unmount } = renderApp("/analytics");
    const usage = await tile("usage");
    expect(within(usage).getByTestId("cost")).toHaveTextContent("Estimated cost: about $0.41");
    expect(within(usage).getByText(/not a bill/)).toBeVisible();
    unmount();

    serve(
      makeSummary({
        usage: {
          input_tokens: 5000,
          output_tokens: 500,
          estimated_cost_usd: null,
          unpriced_tokens: 5500,
        },
      }),
    );
    renderApp("/analytics");
    expect(await screen.findByText(/Cost: not estimated/)).toBeVisible();
  });

  it("draws the charts with a legend, and the same numbers as tables", async () => {
    serve();
    renderApp("/analytics");

    const reviews = await screen.findByRole("region", { name: "Reviews over time" });
    const legend = within(reviews).getByRole("list", { name: "Legend" });
    expect(
      within(legend)
        .getAllByRole("listitem")
        .map((li) => li.textContent),
    ).toEqual(["Partial", "Completed", "Failed"]);
    // Each bar can be reached and named without colour.
    expect(
      within(reviews).getByRole("img", { name: /Oct 1: 1 partial, 2 completed, 0 failed/ }),
    ).toBeInTheDocument();
    const table = within(reviews).getByRole("table", { name: "Reviews per period by outcome" });
    expect(within(table).getByRole("row", { name: /Oct 1 2 1 0/ })).toBeInTheDocument();

    const severity = screen.getByRole("region", { name: "Severity mix" });
    expect(within(severity).getByRole("list", { name: "Findings by severity" })).toHaveTextContent(
      "Critical1",
    );
    expect(within(severity).getByRole("list", { name: "Findings by severity" })).toHaveTextContent(
      "Medium8",
    );

    const duration = screen.getByRole("region", { name: "Duration trend" });
    expect(within(duration).getByText(/The dashed line is the 5-minute target/)).toBeVisible();
    const durations = within(duration).getByRole("table", {
      name: "Median review duration per period",
    });
    expect(within(durations).getByRole("row", { name: /Oct 1 1 m 30 s/ })).toBeInTheDocument();
    expect(within(durations).getByRole("row", { name: /Oct 2 no reviews/ })).toBeInTheDocument();

    const causes = screen.getByRole("region", { name: "Failures and partial results by cause" });
    expect(
      within(causes).getByRole("list", { name: "Partial and failed reviews by cause" }),
    ).toHaveTextContent("An agent timed out1");

    expect(screen.getByRole("region", { name: "Token usage" })).toBeVisible();
  });

  it("asks for another period and repository and keeps them in the address", async () => {
    const seen: URL[] = [];
    serve(makeSummary(), makeSeries(), seen);
    renderApp("/analytics");
    const user = userEvent.setup();
    await tile("reviews");

    await user.selectOptions(screen.getByLabelText("Period"), "90");
    await user.selectOptions(screen.getByLabelText("Repository"), "repo-1");
    await within(await tile("reviews")).findByText("40");

    const last = seen.at(-1)!;
    expect(last.searchParams.get("repo_id")).toBe("repo-1");
    const days = (Date.now() - new Date(last.searchParams.get("from")!).getTime()) / 86_400_000;
    expect(Math.round(days)).toBe(90);
    expect(screen.getByTestId("location")).toHaveTextContent("days=90");
    expect(screen.getByTestId("location")).toHaveTextContent("repo=repo-1");
  });

  it("says when there were no reviews, and offers a longer period", async () => {
    serve(
      makeSummary({
        reviews: {
          total: 0,
          completed: 0,
          partial: 0,
          failed: 0,
          skipped: 0,
          superseded: 0,
          cancelled: 0,
          in_progress: 0,
        },
      }),
    );
    renderApp("/analytics");
    expect(await screen.findByText("No reviews in this period")).toBeVisible();
    expect(screen.getByText(/last 30 days/)).toBeVisible();
  });

  it("shows loading and error states", async () => {
    signedInAs();
    let fail = true;
    server.use(
      http.get(`${API}/api/repos`, () => json({ items: [] })),
      http.get(`${API}/api/analytics/summary`, async () => {
        await new Promise((r) => setTimeout(r, 50));
        return fail ? apiError(500, "internal_error") : json(makeSummary());
      }),
      http.get(`${API}/api/analytics/timeseries`, () => json(makeSeries())),
    );
    renderApp("/analytics");
    expect(await screen.findByText("Loading analytics…")).toBeVisible();
    expect(await screen.findByRole("alert")).toHaveTextContent("The server had a problem");
    fail = false;
    await userEvent.setup().click(screen.getByRole("button", { name: "Try again" }));
    expect(await tile("reviews")).toBeVisible();
  });

  it("keeps the tiles when only the charts fail", async () => {
    signedInAs();
    server.use(
      http.get(`${API}/api/repos`, () => json({ items: [] })),
      http.get(`${API}/api/analytics/summary`, () => json(makeSummary())),
      http.get(`${API}/api/analytics/timeseries`, () => apiError(500, "internal_error")),
    );
    renderApp("/analytics");
    expect(await tile("completion")).toBeVisible();
    expect(await screen.findByText("The charts could not be loaded")).toBeVisible();
  });
});

describe("niceMax", () => {
  it("rounds up to 1, 2 or 5 times a power of ten", () => {
    expect(niceMax(0)).toBe(1);
    expect(niceMax(3)).toBe(5);
    expect(niceMax(5)).toBe(5);
    expect(niceMax(6)).toBe(10);
    expect(niceMax(11)).toBe(20);
    expect(niceMax(430)).toBe(500);
    expect(niceMax(0.3)).toBeCloseTo(0.5);
  });
});
