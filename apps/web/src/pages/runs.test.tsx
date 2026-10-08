// UI-03 and UI-09: the runs list, its filters, the pending view, pinned in-flight runs and cursor pagination.
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http } from "msw";
import { describe, expect, it } from "vitest";
import { API, makeRepo, makeRun, type RunSummaryDto } from "../test/fixtures";
import { apiError, json, renderApp, signedInAs } from "../test/render";
import { server } from "../test/server";

const repos = [
  makeRepo({ id: "repo-1", full_name: "acme/api" }),
  makeRepo({ id: "repo-2", full_name: "acme/web" }),
];

/** Serves repos, and runs through `handler`, which sees the request's query parameters. */
function serve(
  handler: (query: URLSearchParams) => { items: RunSummaryDto[]; next?: string | null },
) {
  const requests: URLSearchParams[] = [];
  signedInAs();
  server.use(
    http.get(`${API}/api/repos`, () => json({ items: repos })),
    http.get(`${API}/api/runs`, ({ request }) => {
      const query = new URL(request.url).searchParams;
      requests.push(query);
      const { items, next = null } = handler(query);
      return json({ items, next_cursor: next });
    }),
  );
  return requests;
}

const rows = (list: HTMLElement) => within(list).getAllByRole("listitem");

describe("Runs page", () => {
  it("shows a loading state, then the runs", async () => {
    signedInAs();
    server.use(
      http.get(`${API}/api/repos`, () => json({ items: repos })),
      http.get(`${API}/api/runs`, async ({ request }) => {
        await new Promise((r) => setTimeout(r, 100));
        const inFlight = new URL(request.url).searchParams.get("status") === "queued,running";
        return json({ items: inFlight ? [] : [makeRun({ pr_number: 7 })], next_cursor: null });
      }),
    );
    renderApp("/runs");
    expect(await screen.findByText("Loading runs…")).toBeVisible();
    expect(await screen.findByRole("link", { name: /acme\/api #7/ })).toBeVisible();
  });

  it("describes each run: repository, pull request, status, branch, trigger, who and findings", async () => {
    serve(() => ({
      items: [
        makeRun({
          id: "run-x",
          pr_number: 12,
          status: "partial",
          base_ref: "release",
          trigger: "comment_command",
          triggered_by: "hubot",
          finding_counts: { critical: 1, high: 2, medium: 0, low: 0, info: 0 },
        }),
      ],
    }));
    renderApp("/runs");
    const row = (await screen.findAllByRole("listitem"))[0]!;
    expect(within(row).getByRole("link", { name: /acme\/api #12/ })).toHaveAttribute(
      "href",
      "/runs/run-x",
    );
    expect(within(row).getByText("Partial")).toBeVisible();
    expect(within(row).getByText("release")).toBeVisible();
    expect(within(row).getByText("Comment command")).toBeVisible();
    expect(within(row).getByText("by hubot")).toBeVisible();
    expect(within(row).getByText("1 critical · 2 high")).toBeVisible();
  });

  it("pins runs in flight above the history and does not list them twice (UI-03)", async () => {
    const running = makeRun({
      id: "run-live",
      status: "running",
      started_at: new Date().toISOString(),
      finished_at: null,
    });
    const queued = makeRun({
      id: "run-wait",
      status: "queued",
      started_at: null,
      finished_at: null,
    });
    const done = makeRun({ id: "run-done", status: "completed" });
    const requests = serve((query) =>
      query.get("status") === "queued,running"
        ? { items: [running, queued] }
        : { items: [running, queued, done] },
    );
    renderApp("/runs");

    const pinned = await screen.findByRole("list", { name: "Runs in progress" });
    expect(rows(pinned)).toHaveLength(2);
    expect(rows(pinned)[0]).toHaveAttribute("data-active", "true");
    expect(screen.getByRole("heading", { name: "In progress (2)" })).toBeVisible();

    const history = screen.getByRole("list", { name: "Runs" });
    expect(rows(history)).toHaveLength(1);
    expect(rows(history)[0]).toHaveAttribute("data-run", "run-done");
    expect(requests.some((q) => q.get("status") === "queued,running")).toBe(true);
  });

  it("filters by repository, status, branch and date, and keeps them in the address (UI-03)", async () => {
    const requests = serve(() => ({ items: [makeRun()] }));
    renderApp("/runs");
    const user = userEvent.setup();
    await screen.findAllByRole("listitem");

    await user.selectOptions(screen.getByLabelText("Repository"), "repo-2");
    await user.selectOptions(screen.getByLabelText("Status"), "failed");
    await user.type(screen.getByLabelText("Base branch"), "release");
    // The branch is applied shortly after typing stops.
    await waitFor(() =>
      expect(screen.getByTestId("location").textContent).toContain("branch=release"),
    );
    fireEvent.change(screen.getByLabelText("From"), { target: { value: "2026-10-01" } });
    await waitFor(() => expect(screen.getByTestId("location").textContent).toContain("from="));
    fireEvent.change(screen.getByLabelText("To"), { target: { value: "2026-10-05" } });

    await waitFor(() => {
      const last = requests.filter((q) => q.get("branch") === "release").at(-1);
      expect(last).toBeDefined();
      expect(last!.get("repo_id")).toBe("repo-2");
      expect(last!.get("status")).toBe("failed");
      // The whole of both days, in the viewer's time zone.
      expect(new Date(last!.get("from")!).getTime()).toBe(
        new Date("2026-10-01T00:00:00").getTime(),
      );
      expect(new Date(last!.get("to")!).getTime()).toBe(
        new Date("2026-10-05T23:59:59.999").getTime(),
      );
    });
    expect(screen.getByTestId("location").textContent).toBe(
      "/runs?repo=repo-2&status=failed&branch=release&from=2026-10-01&to=2026-10-05",
    );
  });

  it("starts from the filters in the address", async () => {
    const requests = serve(() => ({ items: [makeRun()] }));
    renderApp("/runs?repo=repo-1&status=skipped&branch=main");
    await screen.findAllByRole("listitem");
    expect(requests.at(-1)!.get("repo_id")).toBe("repo-1");
    expect(requests.at(-1)!.get("status")).toBe("skipped");
    expect(requests.at(-1)!.get("branch")).toBe("main");
    expect(screen.getByLabelText("Repository")).toHaveValue("repo-1");
    expect(screen.getByLabelText("Status")).toHaveValue("skipped");
    expect(screen.getByLabelText("Base branch")).toHaveValue("main");
  });

  it("shows queued and running runs across repositories in the pending view (UI-09)", async () => {
    const requests = serve(() => ({
      items: [makeRun({ status: "queued", started_at: null, finished_at: null })],
    }));
    renderApp("/runs?view=pending");
    expect(await screen.findByRole("heading", { name: "Pending runs", level: 1 })).toBeVisible();
    expect(requests.every((q) => q.get("status") === "queued,running")).toBe(true);
    expect(screen.queryByLabelText("Status")).toBeNull();
    expect(screen.getByRole("link", { name: "Pending" })).toHaveAttribute("aria-current", "page");
    expect(screen.getByRole("link", { name: "All runs" })).not.toHaveAttribute("aria-current");
  });

  it("explains an empty pending view and an empty history", async () => {
    serve(() => ({ items: [] }));
    const { unmount } = renderApp("/runs?view=pending");
    expect(
      await screen.findByRole("heading", { name: "Nothing is queued or running" }),
    ).toBeVisible();
    unmount();

    renderApp("/runs");
    expect(await screen.findByRole("heading", { name: "No runs yet" })).toBeVisible();
  });

  it("says when filters match nothing, and clears them", async () => {
    const requests = serve((query) => ({
      items: query.get("status") ? [] : [makeRun({ pr_number: 5 })],
    }));
    renderApp("/runs?status=failed");
    expect(
      await screen.findByRole("heading", { name: "No runs match these filters" }),
    ).toBeVisible();

    await userEvent.setup().click(screen.getAllByRole("button", { name: "Clear filters" })[0]!);
    expect(await screen.findByRole("link", { name: /acme\/api #5/ })).toBeVisible();
    expect(requests.at(-1)!.get("status")).toBeNull();
    expect(screen.getByTestId("location").textContent).toBe("/runs");
  });

  it("follows the cursor for more runs", async () => {
    const requests = serve((query) =>
      query.get("cursor") === "c1"
        ? { items: [makeRun({ pr_number: 2 })] }
        : query.get("status") === "queued,running"
          ? { items: [] }
          : { items: [makeRun({ pr_number: 1 })], next: "c1" },
    );
    renderApp("/runs");
    await screen.findByRole("link", { name: /#1$/ });
    expect(screen.queryByRole("link", { name: /#2$/ })).toBeNull();

    await userEvent.setup().click(screen.getByRole("button", { name: "Load more" }));
    expect(await screen.findByRole("link", { name: /#2$/ })).toBeVisible();
    expect(screen.getByRole("link", { name: /#1$/ })).toBeVisible();
    expect(requests.some((q) => q.get("cursor") === "c1")).toBe(true);
    expect(screen.queryByRole("button", { name: "Load more" })).toBeNull();
  });

  it("shows an error with a retry", async () => {
    signedInAs();
    let fail = true;
    server.use(
      http.get(`${API}/api/repos`, () => json({ items: repos })),
      http.get(`${API}/api/runs`, () =>
        fail
          ? apiError(500, "internal_error")
          : json({ items: [makeRun({ pr_number: 3 })], next_cursor: null }),
      ),
    );
    renderApp("/runs");
    expect(await screen.findByRole("alert")).toHaveTextContent(/server had a problem/i);
    fail = false;
    await userEvent.setup().click(screen.getByRole("button", { name: "Try again" }));
    expect(await screen.findByRole("link", { name: /#3$/ })).toBeVisible();
  });
});
