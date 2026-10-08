// UI-05: the findings explorer, one finding, feedback on it (AC-19) and the history of a pull request.
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http } from "msw";
import { describe, expect, it } from "vitest";
import { API, makeRepo, makeRun } from "../test/fixtures";
import { makeExplorerFinding, NO_FEEDBACK } from "../test/insightFixtures";
import { apiError, json, renderApp, signedInAs } from "../test/render";
import { server } from "../test/server";

const repos = [
  makeRepo({ id: "repo-1", full_name: "acme/api" }),
  makeRepo({ id: "repo-2", full_name: "acme/web" }),
];

function serveFindings(handler: (url: URL) => unknown) {
  signedInAs();
  server.use(
    http.get(`${API}/api/repos`, () => json({ items: repos })),
    http.get(`${API}/api/findings`, ({ request }) => json(handler(new URL(request.url)))),
  );
}

describe("Findings explorer", () => {
  it("lists findings with their severity, place, pull request and a link to GitHub", async () => {
    serveFindings(() => ({
      items: [
        makeExplorerFinding({
          id: "f1",
          title: "SQL built from input",
          severity: "critical",
          category: "security",
          file_path: "src/db.ts",
          start_line: 4,
          end_line: 4,
          pr_number: 88,
        }),
        makeExplorerFinding({
          id: "f2",
          title: "Long function",
          severity: "low",
          posted: false,
          github_url: null,
          file_path: null,
          start_line: null,
          end_line: null,
        }),
      ],
      next_cursor: null,
    }));
    renderApp("/findings");

    const list = await screen.findByRole("list", { name: "Findings" });
    const [first, second] = within(list).getAllByRole("listitem");
    expect(within(first!).getByText("Critical")).toBeVisible();
    expect(within(first!).getByRole("link", { name: "SQL built from input" })).toHaveAttribute(
      "href",
      "/findings/f1",
    );
    expect(within(first!).getByText("src/db.ts:4")).toBeVisible();
    expect(within(first!).getByRole("link", { name: /acme\/api #88/ })).toHaveAttribute(
      "href",
      "/runs/run-1",
    );
    const github = within(first!).getByRole("link", { name: /Comment on GitHub/ });
    expect(github).toHaveAttribute("href", expect.stringContaining("#discussion_r"));
    expect(github).toHaveAttribute("rel", "noopener noreferrer");
    // A general finding has no place and no GitHub link.
    expect(within(second!).getByText("General")).toBeVisible();
    expect(within(second!).queryByRole("link", { name: /GitHub/ })).toBeNull();
    expect(within(second!).getByText("Summary only")).toBeVisible();
  });

  it("sends the filters to the api and keeps them in the address", async () => {
    const seen: URL[] = [];
    serveFindings((url) => {
      seen.push(url);
      return { items: [], next_cursor: null };
    });
    renderApp("/findings");
    const user = userEvent.setup();
    await screen.findByText("No findings yet");

    await user.selectOptions(screen.getByLabelText("Severity"), "high");
    await user.selectOptions(screen.getByLabelText("Category"), "security");
    await user.selectOptions(screen.getByLabelText("Agent"), "security");
    await user.selectOptions(screen.getByLabelText("Status"), "suppressed");
    await user.selectOptions(screen.getByLabelText("Repository"), "repo-2");
    await user.type(screen.getByLabelText("File path contains"), "src/auth");

    await waitFor(() => {
      const last = seen.at(-1)!;
      expect(last.searchParams.get("severity")).toBe("high");
      expect(last.searchParams.get("category")).toBe("security");
      expect(last.searchParams.get("agent")).toBe("security");
      expect(last.searchParams.get("status")).toBe("suppressed");
      expect(last.searchParams.get("repo_id")).toBe("repo-2");
      expect(last.searchParams.get("path")).toBe("src/auth");
    });
    const location = screen.getByTestId("location").textContent!;
    expect(location).toContain("severity=high");
    expect(location).toContain("path=src%2Fauth");
  });

  it("turns a date range into whole days", async () => {
    const seen: URL[] = [];
    serveFindings((url) => {
      seen.push(url);
      return { items: [], next_cursor: null };
    });
    renderApp("/findings?from=2026-10-01&to=2026-10-03");
    await screen.findByText(/No findings match/);
    const last = seen.at(-1)!;
    expect(new Date(last.searchParams.get("from")!).getTime()).toBe(
      new Date("2026-10-01T00:00:00").getTime(),
    );
    expect(new Date(last.searchParams.get("to")!).getTime()).toBe(
      new Date("2026-10-03T23:59:59.999").getTime(),
    );
  });

  it("pages with the cursor", async () => {
    const seen: Array<string | null> = [];
    serveFindings((url) => {
      seen.push(url.searchParams.get("cursor"));
      return url.searchParams.get("cursor")
        ? { items: [makeExplorerFinding({ id: "f9", title: "On page two" })], next_cursor: null }
        : {
            items: [makeExplorerFinding({ id: "f1", title: "On page one" })],
            next_cursor: "cursor-1",
          };
    });
    renderApp("/findings");
    const user = userEvent.setup();
    await screen.findByText("On page one");
    await user.click(screen.getByRole("button", { name: "Load more" }));
    await screen.findByText("On page two");
    expect(seen).toEqual([null, "cursor-1"]);
    expect(screen.getByText("On page one")).toBeVisible();
    expect(screen.queryByRole("button", { name: "Load more" })).toBeNull();
  });

  it("says when nothing matches and clears the filters", async () => {
    serveFindings((url) => ({
      items: url.searchParams.get("severity") ? [] : [makeExplorerFinding({ title: "Everything" })],
      next_cursor: null,
    }));
    renderApp("/findings?severity=low");
    const user = userEvent.setup();
    expect(await screen.findByText("No findings match these filters")).toBeVisible();
    await user.click(screen.getAllByRole("button", { name: "Clear filters" })[0]!);
    expect(await screen.findByText("Everything")).toBeVisible();
    expect(screen.getByTestId("location")).toHaveTextContent("/findings");
  });

  it("shows an error with a retry", async () => {
    signedInAs();
    let fail = true;
    server.use(
      http.get(`${API}/api/repos`, () => json({ items: repos })),
      http.get(`${API}/api/findings`, () =>
        fail
          ? apiError(500, "internal_error")
          : json({ items: [makeExplorerFinding({ title: "Back again" })], next_cursor: null }),
      ),
    );
    renderApp("/findings");
    const user = userEvent.setup();
    expect(await screen.findByRole("alert")).toHaveTextContent("The server had a problem");
    fail = false;
    await user.click(screen.getByRole("button", { name: "Try again" }));
    expect(await screen.findByText("Back again")).toBeVisible();
  });

  it("marks a finding that was left out of the review and offers no feedback on it", async () => {
    serveFindings(() => ({
      items: [
        makeExplorerFinding({
          title: "Dropped",
          posted: false,
          suppressed_reason: "below_threshold",
        }),
      ],
      next_cursor: null,
    }));
    renderApp("/findings?status=suppressed");
    expect(await screen.findByText(/Not reported: below the thresholds/)).toBeVisible();
    expect(screen.queryByRole("button", { name: "Useful" })).toBeNull();
    expect(screen.getByText(/cannot be rated/)).toBeVisible();
  });
});

describe("feedback (AC-19)", () => {
  it("sends the verdict, shows the answer and refreshes the list", async () => {
    let feedback = { ...NO_FEEDBACK } as Record<string, unknown>;
    const posts: unknown[] = [];
    signedInAs();
    server.use(
      http.get(`${API}/api/repos`, () => json({ items: repos })),
      http.get(`${API}/api/findings`, () =>
        json({
          items: [makeExplorerFinding({ id: "f1", feedback: feedback as never })],
          next_cursor: null,
        }),
      ),
      http.post(`${API}/api/findings/f1/feedback`, async ({ request }) => {
        const body = (await request.json()) as { verdict: string; note?: string };
        posts.push(body);
        feedback = {
          useful: 1,
          false_positive: 0,
          known: 0,
          mine: { verdict: body.verdict, note: body.note ?? null },
        };
        return json({ feedback });
      }),
    );
    renderApp("/findings");
    const user = userEvent.setup();

    const useful = await screen.findByRole("button", { name: "Useful" });
    expect(useful).toHaveAttribute("aria-pressed", "false");
    await user.click(useful);

    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Useful" })).toHaveAttribute(
        "aria-pressed",
        "true",
      ),
    );
    expect(posts).toEqual([{ verdict: "useful" }]);
    expect(screen.getByRole("button", { name: "False positive" })).toHaveAttribute(
      "aria-pressed",
      "false",
    );
    expect(await screen.findByText(/1 useful/)).toBeVisible();
  });

  it("lets a person add a note to their vote", async () => {
    const posts: unknown[] = [];
    signedInAs();
    server.use(
      http.get(`${API}/api/repos`, () => json({ items: repos })),
      http.get(`${API}/api/findings`, () =>
        json({
          items: [
            makeExplorerFinding({
              id: "f1",
              feedback: {
                useful: 0,
                false_positive: 1,
                known: 0,
                mine: { verdict: "false_positive", note: null },
              },
            }),
          ],
          next_cursor: null,
        }),
      ),
      http.post(`${API}/api/findings/f1/feedback`, async ({ request }) => {
        posts.push(await request.json());
        return json({
          feedback: {
            useful: 0,
            false_positive: 1,
            known: 0,
            mine: { verdict: "false_positive", note: "Validated upstream" },
          },
        });
      }),
    );
    renderApp("/findings");
    const user = userEvent.setup();

    await user.click(await screen.findByRole("button", { name: "Add a note" }));
    await user.type(screen.getByLabelText(/Note \(optional/), "Validated upstream");
    await user.click(screen.getByRole("button", { name: "Save note" }));
    await waitFor(() =>
      expect(posts).toEqual([{ verdict: "false_positive", note: "Validated upstream" }]),
    );
  });

  it("says when a vote could not be saved", async () => {
    signedInAs();
    server.use(
      http.get(`${API}/api/repos`, () => json({ items: repos })),
      http.get(`${API}/api/findings`, () =>
        json({ items: [makeExplorerFinding({ id: "f1" })], next_cursor: null }),
      ),
      http.post(`${API}/api/findings/f1/feedback`, () => apiError(500, "internal_error")),
    );
    renderApp("/findings");
    await userEvent.setup().click(await screen.findByRole("button", { name: "Already known" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("The server had a problem");
  });
});

describe("Finding detail", () => {
  const serveOne = (finding = makeExplorerFinding({ id: "f1" })) => {
    signedInAs();
    server.use(http.get(`${API}/api/findings/f1`, () => json(finding)));
  };

  it("shows the evidence, impact, recommendation, suggested test and the way to GitHub", async () => {
    serveOne(
      makeExplorerFinding({
        id: "f1",
        title: "Missing await",
        suggested_test: "Reject when the call fails",
        repo_id: "repo-1",
        pr_number: 7,
      }),
    );
    renderApp("/findings/f1");
    expect(await screen.findByRole("heading", { level: 1, name: "Missing await" })).toBeVisible();
    expect(screen.getByText("user.name is read before the null check")).toBeVisible();
    expect(screen.getByText("Throws a TypeError for anonymous users.")).toBeVisible();
    expect(screen.getByText("Check for null first.")).toBeVisible();
    expect(screen.getByText("Reject when the call fails")).toBeVisible();
    expect(screen.getByRole("link", { name: /Open the comment on GitHub/ })).toHaveAttribute(
      "href",
      expect.stringContaining("discussion_r"),
    );
    expect(screen.getByRole("link", { name: "History of this pull request" })).toHaveAttribute(
      "href",
      "/repos/repo-1/pulls/7",
    );
    expect(screen.getByRole("group", { name: "Was this finding useful?" })).toBeVisible();
    expect(document.title).toContain("Missing await");
  });

  it("links the code when there is no comment, and says so when there is no place", async () => {
    serveOne(
      makeExplorerFinding({
        id: "f1",
        posted: false,
        github_url: "https://github.com/acme/api/blob/abc/src/a.ts#L3",
      }),
    );
    const { unmount } = renderApp("/findings/f1");
    expect(await screen.findByRole("link", { name: /Open the code on GitHub/ })).toBeVisible();
    unmount();

    serveOne(
      makeExplorerFinding({
        id: "f1",
        file_path: null,
        start_line: null,
        end_line: null,
        github_url: null,
      }),
    );
    renderApp("/findings/f1");
    expect(await screen.findByText(/no place in the code/)).toBeVisible();
  });

  it("offers no vote on a finding that was left out", async () => {
    serveOne(makeExplorerFinding({ id: "f1", posted: false, suppressed_reason: "style_only" }));
    renderApp("/findings/f1");
    expect(await screen.findByText(/nothing to rate/)).toBeVisible();
    expect(screen.queryByRole("button", { name: "Useful" })).toBeNull();
  });

  it("says when the finding is not found", async () => {
    signedInAs();
    server.use(http.get(`${API}/api/findings/f1`, () => apiError(404, "not_found")));
    renderApp("/findings/f1");
    expect(await screen.findByText("Finding not found")).toBeVisible();
    expect(screen.getByRole("link", { name: /All findings/ })).toHaveAttribute("href", "/findings");
  });
});

describe("History of a pull request", () => {
  const ref = (id: string, title: string, severity = "high") => ({
    id,
    agent: "code_review" as const,
    category: "bug" as const,
    severity: severity as "high",
    title,
    file_path: `src/${id}.ts`,
    start_line: 5,
  });

  const serveHistory = (runs: unknown[], extra: Record<string, unknown> = {}) => {
    signedInAs();
    server.use(
      http.get(`${API}/api/repos/repo-1/pulls/42/history`, () =>
        json({
          repo_id: "repo-1",
          repo_full_name: "acme/api",
          pr_number: 42,
          pr_url: "https://github.com/acme/api/pull/42",
          runs,
          truncated: false,
          ...extra,
        }),
      ),
    );
  };

  it("lists the runs in order with what changed between reviews", async () => {
    serveHistory([
      {
        run: makeRun({ id: "r1", head_sha: "1".repeat(40) }),
        changes: {
          compared_to: null,
          new: [ref("a", "Missing await"), ref("b", "Off by one")],
          still_applicable: [],
          resolved: [],
          not_evaluated: [],
        },
      },
      {
        run: makeRun({ id: "r2", head_sha: "2".repeat(40), trigger: "dashboard_rerun" }),
        changes: {
          compared_to: "r1",
          new: [ref("c", "Leaky timer")],
          still_applicable: [ref("a", "Missing await")],
          resolved: [ref("b", "Off by one")],
          not_evaluated: [ref("d", "Hidden risk")],
        },
      },
      {
        run: makeRun({
          id: "r3",
          status: "failed",
          status_reason: "No provider key is configured",
          head_sha: "3".repeat(40),
        }),
        changes: null,
      },
    ]);
    renderApp("/repos/repo-1/pulls/42");

    const list = await screen.findByRole("list", {
      name: /Runs of this pull request, oldest first/,
    });
    // The runs are the list's own items; the findings inside them are nested lists.
    const [first, second, third] = Array.from(list.children) as HTMLElement[];
    expect(within(first!).getByTestId("change-summary")).toHaveTextContent("2 new (first review)");
    expect(within(second!).getByTestId("change-summary")).toHaveTextContent(
      "1 new · 1 still applicable · 1 resolved · 1 not evaluated",
    );
    expect(
      within(second!).getByText("Reported before; this review looked again and found nothing."),
    ).toBeVisible();
    expect(within(second!).getByRole("link", { name: "Leaky timer" })).toHaveAttribute(
      "href",
      "/findings/c",
    );
    expect(within(second!).getByText("Dashboard re-run", { exact: false })).toBeVisible();
    expect(within(third!).getByText(/did not produce a review/)).toBeVisible();
    expect(within(third!).getByText("No provider key is configured")).toBeVisible();
    expect(screen.getByRole("link", { name: /Open the pull request on GitHub/ })).toHaveAttribute(
      "href",
      "https://github.com/acme/api/pull/42",
    );
  });

  it("says when a review found nothing, before or now", async () => {
    serveHistory([
      {
        run: makeRun({ id: "r1" }),
        changes: {
          compared_to: null,
          new: [],
          still_applicable: [],
          resolved: [],
          not_evaluated: [],
        },
      },
      {
        run: makeRun({ id: "r2" }),
        changes: {
          compared_to: "r1",
          new: [],
          still_applicable: [],
          resolved: [],
          not_evaluated: [],
        },
      },
    ]);
    renderApp("/repos/repo-1/pulls/42");
    expect(await screen.findByText("The review reported nothing.")).toBeVisible();
    expect(screen.getByText("No findings, and none before.")).toBeVisible();
  });

  it("notes when only the latest runs are listed", async () => {
    serveHistory([{ run: makeRun({ id: "r1" }), changes: null }], { truncated: true });
    renderApp("/repos/repo-1/pulls/42");
    expect(await screen.findByText(/Only the latest 1 runs are shown/)).toBeVisible();
  });

  it("explains an empty history and a bad number", async () => {
    signedInAs();
    server.use(
      http.get(`${API}/api/repos/repo-1/pulls/42/history`, () => apiError(404, "not_found")),
    );
    const { unmount } = renderApp("/repos/repo-1/pulls/42");
    expect(await screen.findByText("No runs for this pull request")).toBeVisible();
    unmount();
    renderApp("/repos/repo-1/pulls/abc");
    expect(await screen.findByText("That is not a pull request number.")).toBeVisible();
  });
});
