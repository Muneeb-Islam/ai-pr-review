// UI-08 and AC-21: re-run and cancel from the run page with a confirmation, who may use them, what a failure
// looks like; the previous-review tracking and feedback inside a run; and the audit view.
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http } from "msw";
import { describe, expect, it } from "vitest";
import {
  API,
  makeDetail,
  makeFinding,
  makeMe,
  makeRepo,
  makeRun,
  type RunDetailDto,
} from "../test/fixtures";
import { apiError, json, renderApp, signedInAs } from "../test/render";
import { server } from "../test/server";

function serveRun(run: RunDetailDto, role: "admin" | "viewer" = "admin") {
  const calls = { rerun: 0, cancel: 0, csrf: [] as Array<string | null> };
  signedInAs();
  server.use(
    http.get(`${API}/api/repos`, () =>
      json({ items: [makeRepo({ id: run.repo_id, full_name: run.repo_full_name, role })] }),
    ),
    http.get(`${API}/api/runs/${run.id}`, () => json(run)),
    http.post(`${API}/api/runs/${run.id}/rerun`, ({ request }) => {
      calls.rerun += 1;
      calls.csrf.push(request.headers.get("x-csrf-token"));
      return json(
        { run: makeRun({ id: "run-new", status: "queued", parent_run_id: run.id }), created: true },
        202,
      );
    }),
    http.post(`${API}/api/runs/${run.id}/cancel`, () => {
      calls.cancel += 1;
      return json({ run: makeRun({ id: run.id, status: "cancelled" }) });
    }),
    http.get(`${API}/api/runs/run-new`, () =>
      json(
        makeDetail({
          id: "run-new",
          status: "queued",
          started_at: null,
          finished_at: null,
          parent_run_id: run.id,
          agent_runs: [],
        }),
      ),
    ),
  );
  return calls;
}

const done = () => makeDetail({ id: "run-1", repo_id: "repo-1", status: "completed" });
const active = () =>
  makeDetail({
    id: "run-1",
    repo_id: "repo-1",
    status: "running",
    finished_at: null,
    agent_runs: [],
  });

describe("Re-run", () => {
  it("asks first, then queues a linked run and opens it", async () => {
    const calls = serveRun(done());
    renderApp("/runs/run-1");
    const user = userEvent.setup();

    await user.click(await screen.findByRole("button", { name: "Re-run review" }));
    const dialog = await screen.findByRole("alertdialog", { name: "Re-run this review?" });
    expect(dialog).toHaveTextContent(/new run is queued for the commit/);
    expect(dialog).toHaveTextContent(/audit log/);
    expect(calls.rerun).toBe(0);

    await user.click(within(dialog).getByRole("button", { name: "Re-run" }));
    await waitFor(() => expect(screen.getByTestId("location")).toHaveTextContent("/runs/run-new"));
    expect(calls.rerun).toBe(1);
    expect(calls.csrf).toEqual(["csrf-1"]);
    // The new run shows where it came from, and is live like any other.
    expect(await screen.findByText("Re-run of")).toBeVisible();
    expect(await screen.findByText("Queued", { selector: "[data-status]" })).toBeVisible();
  });

  it("does nothing when the dialog is cancelled", async () => {
    const calls = serveRun(done());
    renderApp("/runs/run-1");
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "Re-run review" }));
    await user.click(
      within(await screen.findByRole("alertdialog")).getByRole("button", { name: "Cancel" }),
    );
    expect(screen.queryByRole("alertdialog")).toBeNull();
    expect(calls.rerun).toBe(0);
    expect(screen.getByTestId("location")).toHaveTextContent("/runs/run-1");
  });

  it("shows why a re-run was refused and stays on the run", async () => {
    serveRun(done());
    server.use(
      http.post(`${API}/api/runs/run-1/rerun`, () =>
        apiError(
          409,
          "pull_request_closed",
          "The pull request is closed, so there is nothing to review.",
        ),
      ),
    );
    renderApp("/runs/run-1");
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "Re-run review" }));
    await user.click(
      within(await screen.findByRole("alertdialog")).getByRole("button", { name: "Re-run" }),
    );
    expect(
      await screen.findByText("The pull request is closed, so there is nothing to review."),
    ).toBeVisible();
    expect(screen.getByTestId("location")).toHaveTextContent("/runs/run-1");
  });
});

describe("Cancel", () => {
  it("cancels an active run after confirmation", async () => {
    const calls = serveRun(active());
    renderApp("/runs/run-1");
    const user = userEvent.setup();

    await user.click(await screen.findByRole("button", { name: "Cancel run" }));
    const dialog = await screen.findByRole("alertdialog", { name: "Cancel this run?" });
    await user.click(within(dialog).getByRole("button", { name: "Keep running" }));
    expect(calls.cancel).toBe(0);

    await user.click(screen.getByRole("button", { name: "Cancel run" }));
    await user.click(
      within(await screen.findByRole("alertdialog")).getByRole("button", { name: "Cancel run" }),
    );
    await waitFor(() => expect(calls.cancel).toBe(1));
    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
  });

  it("cannot be used on a run that has finished", async () => {
    serveRun(done());
    renderApp("/runs/run-1");
    expect(await screen.findByRole("button", { name: "Cancel run" })).toBeDisabled();
    expect(screen.getByText("A run that has finished cannot be cancelled.")).toBeVisible();
    expect(screen.getByRole("button", { name: "Re-run review" })).toBeEnabled();
  });

  it("shows a refusal, such as a run that finished a moment ago", async () => {
    serveRun(active());
    server.use(
      http.post(`${API}/api/runs/run-1/cancel`, () =>
        apiError(409, "run_not_active", "The run has already finished, so it cannot be cancelled."),
      ),
    );
    renderApp("/runs/run-1");
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "Cancel run" }));
    await user.click(
      within(await screen.findByRole("alertdialog")).getByRole("button", { name: "Cancel run" }),
    );
    expect(
      await screen.findByText("The run has already finished, so it cannot be cancelled."),
    ).toBeVisible();
  });
});

describe("Who may re-run and cancel", () => {
  it("shows both disabled, with the reason, to people who are not admins", async () => {
    const calls = serveRun(active(), "viewer");
    renderApp("/runs/run-1");
    const rerun = await screen.findByRole("button", { name: "Re-run review" });
    const cancel = screen.getByRole("button", { name: "Cancel run" });
    expect(rerun).toBeDisabled();
    expect(cancel).toBeDisabled();
    expect(rerun).toHaveAccessibleDescription(
      "Only repository admins can re-run or cancel a review.",
    );
    expect(calls.rerun + calls.cancel).toBe(0);
  });
});

describe("Run detail: previous review and feedback", () => {
  it("shows what became of the previous review's findings", async () => {
    serveRun(
      makeDetail({
        id: "run-1",
        repo_id: "repo-1",
        tracking: {
          previous_run_id: "run-0",
          previous_head_sha: "c".repeat(40),
          items: [
            {
              state: "resolved",
              agent: "code_review",
              category: "bug",
              severity: "high",
              title: "Fixed since",
              file_path: "src/a.ts",
              start_line: 4,
              reason: null,
            },
            {
              state: "still_applicable",
              agent: "code_review",
              category: "bug",
              severity: "medium",
              title: "Still here",
              file_path: "src/b.ts",
              start_line: 9,
              reason: null,
            },
            {
              state: "not_evaluated",
              agent: "security",
              category: "security",
              severity: "high",
              title: "Could not tell",
              file_path: null,
              start_line: null,
              reason: "The Security check did not finish this time.",
            },
          ],
        },
        final_review: { status: "ok", reviewed: 5, approved: 4, rejected: 1, unreviewed: 0 },
        findings: [makeFinding({ id: "f1", title: "Kept" })],
      }),
    );
    renderApp("/runs/run-1");

    const section = await screen.findByRole("region", { name: "Since the previous review" });
    expect(
      within(section).getByText(/1 resolved · 1 still applicable · 1 not evaluated/),
    ).toBeVisible();
    expect(within(section).getByRole("link", { name: "that run" })).toHaveAttribute(
      "href",
      "/runs/run-0",
    );
    const items = within(section).getByRole("list", { name: "Findings of the previous review" });
    expect(within(items).getByText("Fixed since").closest("li")).toHaveAttribute(
      "data-state",
      "resolved",
    );
    expect(within(items).getByText("The Security check did not finish this time.")).toBeVisible();
    expect(screen.getByTestId("final-review")).toHaveTextContent(
      "Final review: 4 approved, 1 rejected.",
    );
    expect(
      screen.getByRole("link", { name: "History of this pull request" }).getAttribute("href"),
    ).toMatch(/^\/repos\/repo-1\/pulls\/\d+$/);
  });

  it("has no previous-review section when there was nothing to compare with", async () => {
    serveRun(done());
    renderApp("/runs/run-1");
    await screen.findByRole("heading", { name: "Agents" });
    expect(screen.queryByRole("region", { name: "Since the previous review" })).toBeNull();
  });

  it("lets a person rate a finding from the run page and links it to GitHub", async () => {
    const posts: unknown[] = [];
    serveRun(
      makeDetail({
        id: "run-1",
        repo_id: "repo-1",
        findings: [makeFinding({ id: "f1", title: "Rate me" })],
      }),
    );
    server.use(
      http.post(`${API}/api/findings/f1/feedback`, async ({ request }) => {
        posts.push(await request.json());
        return json({
          feedback: {
            useful: 0,
            false_positive: 1,
            known: 0,
            mine: { verdict: "false_positive", note: null },
          },
        });
      }),
    );
    renderApp("/runs/run-1");
    const user = userEvent.setup();
    const item = (await screen.findByText("Rate me")).closest("li") as HTMLElement;
    await user.click(within(item).getByRole("button", { name: "False positive" }));
    await waitFor(() => expect(posts).toEqual([{ verdict: "false_positive" }]));
    expect(within(item).getByRole("link", { name: /Comment on GitHub/ })).toHaveAttribute(
      "href",
      expect.stringContaining("discussion_r"),
    );
    expect(within(item).getByRole("link", { name: "Details" })).toHaveAttribute(
      "href",
      "/findings/f1",
    );
  });
});

describe("Audit log", () => {
  const entry = (
    id: string,
    action: string,
    target: string,
    login: string | null,
    metadata: Record<string, unknown> = {},
  ) => ({
    id,
    at: "2026-10-05T09:00:00.000Z",
    user_login: login,
    action,
    target,
    metadata,
  });

  function serveAudit(role: "admin" | "viewer", handler?: (url: URL) => unknown) {
    signedInAs(
      makeMe({
        installations: [{ id: "i1", account_login: "acme", account_type: "organization", role }],
      }),
    );
    server.use(
      http.get(`${API}/api/installations/i1/audit`, ({ request }) => {
        const url = new URL(request.url);
        if (handler) return json(handler(url));
        return role === "admin"
          ? json({
              items: [
                entry("e1", "settings.update", "repo:repo-9", "alice", {
                  keys: ["review", "agents"],
                }),
                entry("e2", "run.rerun", "run:run-7", "bob", { head_sha: "abc", created: true }),
                entry("e3", "credential.put", "repo:repo-9", null, {
                  provider: "deepseek",
                  scope: "repository",
                }),
              ],
              next_cursor: null,
            })
          : apiError(403, "forbidden");
      }),
    );
  }

  it("lists who did what, to what, with names of what changed and never a value", async () => {
    serveAudit("admin");
    renderApp("/installations/i1/audit");
    const table = await screen.findByRole("table", { name: "Audit log entries, newest first" });
    const rows = within(table).getAllByRole("row").slice(1);
    expect(rows).toHaveLength(3);
    expect(within(rows[0]!).getByText("alice")).toBeVisible();
    expect(within(rows[0]!).getByText("Changed repository settings")).toBeVisible();
    expect(within(rows[0]!).getByRole("link", { name: "repository settings" })).toHaveAttribute(
      "href",
      "/repos/repo-9/settings",
    );
    expect(within(rows[0]!).getByText("keys: review, agents")).toBeVisible();
    expect(within(rows[1]!).getByRole("link", { name: "run" })).toHaveAttribute(
      "href",
      "/runs/run-7",
    );
    expect(within(rows[2]!).getByText("Set a provider key")).toBeVisible();
    expect(within(rows[2]!).getByText("an account that no longer exists")).toBeVisible();
    expect(within(rows[2]!).getByText("provider: deepseek · scope: repository")).toBeVisible();
  });

  it("filters by action and pages", async () => {
    const seen: URL[] = [];
    serveAudit("admin", (url) => {
      seen.push(url);
      return url.searchParams.get("cursor")
        ? { items: [entry("e9", "run.cancel", "run:run-1", "alice")], next_cursor: null }
        : { items: [entry("e1", "run.rerun", "run:run-2", "alice")], next_cursor: "next" };
    });
    renderApp("/installations/i1/audit");
    const user = userEvent.setup();
    await screen.findByText("Re-ran a review", { selector: "td" });
    await user.click(screen.getByRole("button", { name: "Load more" }));
    expect(await screen.findByText("Cancelled a review", { selector: "td" })).toBeVisible();

    await user.selectOptions(screen.getByLabelText("Action"), "run.rerun");
    await waitFor(() => expect(seen.at(-1)!.searchParams.get("action")).toBe("run.rerun"));
    expect(screen.getByTestId("location")).toHaveTextContent("action=run.rerun");
  });

  it("tells members it is for admins", async () => {
    serveAudit("viewer");
    renderApp("/installations/i1/audit");
    expect(await screen.findByText("Only admins can see the audit log")).toBeVisible();
  });

  it("says when nothing is recorded yet", async () => {
    serveAudit("admin", () => ({ items: [], next_cursor: null }));
    renderApp("/installations/i1/audit");
    expect(await screen.findByText("Nothing recorded yet")).toBeVisible();
  });
});
