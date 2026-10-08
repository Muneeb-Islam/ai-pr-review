// UI-02: the repository list, with loading, empty and error states.
import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http } from "msw";
import { describe, expect, it } from "vitest";
import { API, makeRepo, makeRun } from "../test/fixtures";
import { apiError, json, renderApp, signedInAs } from "../test/render";
import { server } from "../test/server";

const serveRepos = (items: unknown[]) =>
  server.use(http.get(`${API}/api/repos`, () => json({ items })));

describe("Repositories page", () => {
  it("shows a loading state first", async () => {
    signedInAs();
    server.use(
      http.get(`${API}/api/repos`, async () => {
        await new Promise((r) => setTimeout(r, 100));
        return json({ items: [] });
      }),
    );
    renderApp("/repos");
    expect(await screen.findByText("Loading repositories…")).toBeVisible();
    expect(screen.getByRole("status")).toBeInTheDocument();
  });

  it("lists each repository with visibility, enabled state and the last run", async () => {
    signedInAs();
    const run = makeRun({ id: "r9", status: "failed", pr_number: 42, finished_at: null });
    serveRepos([
      makeRepo({
        id: "repo-a",
        full_name: "acme/api",
        is_private: true,
        enabled: true,
        last_run: {
          id: run.id,
          status: "failed",
          pr_number: 42,
          queued_at: new Date(Date.now() - 3 * 60_000).toISOString(),
          finished_at: null,
        },
      }),
      makeRepo({ id: "repo-b", full_name: "acme/web", is_private: false, enabled: false }),
    ]);
    renderApp("/repos");

    const list = await screen.findByRole("list", { name: "Repositories" });
    const [api, web] = within(list).getAllByRole("listitem");
    expect(within(api!).getByText("Private")).toBeVisible();
    expect(within(api!).getByText("Enabled")).toBeVisible();
    expect(within(api!).getByText("Failed")).toBeVisible();
    expect(within(api!).getByText(/#42/)).toBeVisible();
    expect(within(api!).getByText("3 minutes ago")).toBeVisible();

    expect(within(web!).getByText("Public")).toBeVisible();
    expect(within(web!).getByText("Disabled")).toBeVisible();
    expect(within(web!).getByText("No runs yet")).toBeVisible();
  });

  it("links each repository to its runs", async () => {
    signedInAs();
    serveRepos([makeRepo({ id: "repo-a", full_name: "acme/api" })]);
    renderApp("/repos");
    const link = await screen.findByRole("link", { name: /acme\/api/ });
    expect(link).toHaveAttribute("href", "/runs?repo=repo-a");
  });

  it("filters by name as you type", async () => {
    signedInAs();
    serveRepos([makeRepo({ full_name: "acme/api" }), makeRepo({ full_name: "acme/web" })]);
    renderApp("/repos");
    const user = userEvent.setup();
    await user.type(await screen.findByLabelText("Search repositories"), "web");
    expect(screen.queryByRole("link", { name: /acme\/api/ })).toBeNull();
    expect(screen.getByRole("link", { name: /acme\/web/ })).toBeVisible();

    await user.clear(screen.getByLabelText("Search repositories"));
    await user.type(screen.getByLabelText("Search repositories"), "nothing");
    expect(screen.getByText("No repository matches your search")).toBeVisible();
  });

  it("explains an empty list", async () => {
    signedInAs();
    serveRepos([]);
    renderApp("/repos");
    expect(await screen.findByRole("heading", { name: "No repositories yet" })).toBeVisible();
  });

  it("shows an error with a way to retry", async () => {
    signedInAs();
    let fail = true;
    server.use(
      http.get(`${API}/api/repos`, () =>
        fail ? apiError(500, "internal_error", "Internal error") : json({ items: [makeRepo()] }),
      ),
    );
    renderApp("/repos");
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent(/server had a problem/i);
    expect(alert).toHaveTextContent("req-test-1");

    fail = false;
    await userEvent.setup().click(screen.getByRole("button", { name: "Try again" }));
    expect(await screen.findByRole("list", { name: "Repositories" })).toBeVisible();
  });
});
