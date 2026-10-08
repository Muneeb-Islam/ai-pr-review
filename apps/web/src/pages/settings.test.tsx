// UI-06: the settings pages: editing, validation, the repository file, unsaved changes, keys, and read-only for
// people who are not admins (the api enforces the same rules; see apps/api/src/authorization.test.ts).
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http } from "msw";
import { describe, expect, it } from "vitest";
import { API, makeMe, makeRepo } from "../test/fixtures";
import {
  makeInstallationSettings,
  makeSettings,
  type RepoSettingsDto,
} from "../test/insightFixtures";
import { apiError, json, renderApp, signedInAs } from "../test/render";
import { server } from "../test/server";

interface Calls {
  patches: Array<{ body: unknown; csrf: string | null }>;
  puts: unknown[];
  tests: unknown[];
  deletes: string[];
}

function serveRepo(
  o: {
    role?: "admin" | "viewer";
    settings?: RepoSettingsDto;
    credentials?: unknown[];
    patchResponse?: (body: unknown) => Response;
  } = {},
): Calls {
  const calls: Calls = { patches: [], puts: [], tests: [], deletes: [] };
  let settings = o.settings ?? makeSettings();
  signedInAs();
  server.use(
    http.get(`${API}/api/repos`, () => json({ items: [] })),
    http.get(`${API}/api/repos/repo-1`, () =>
      json(makeRepo({ id: "repo-1", full_name: "acme/api", role: o.role ?? "admin" })),
    ),
    http.get(`${API}/api/repos/repo-1/settings`, () => json(settings)),
    http.patch(`${API}/api/repos/repo-1/settings`, async ({ request }) => {
      const body = (await request.json()) as {
        config?: Record<string, unknown>;
        enabled?: boolean;
      };
      calls.patches.push({ body, csrf: request.headers.get("x-csrf-token") });
      if (o.patchResponse) return o.patchResponse(body);
      settings = {
        ...settings,
        enabled: body.enabled ?? settings.enabled,
        config: { ...settings.config, ...(body.config ?? {}) },
        updated_at: new Date().toISOString(),
      };
      return json(settings);
    }),
    http.get(`${API}/api/repos/repo-1/credentials`, () => json({ items: o.credentials ?? [] })),
    http.put(`${API}/api/repos/repo-1/credentials`, async ({ request }) => {
      const body = (await request.json()) as { provider: string };
      calls.puts.push(body);
      return json({
        credential: {
          id: "c1",
          provider: body.provider,
          scope: "repository",
          last4: "9999",
          created_at: "2026-10-05T10:00:00.000Z",
        },
      });
    }),
    http.post(`${API}/api/repos/repo-1/credentials/test`, async ({ request }) => {
      calls.tests.push(await request.json());
      return json({ ok: true, message: "The provider accepted the key." });
    }),
    http.delete(`${API}/api/repos/repo-1/credentials`, ({ request }) => {
      calls.deletes.push(new URL(request.url).searchParams.get("provider")!);
      return json({ ok: true });
    }),
  );
  return calls;
}

const credential = (provider: string, last4 = "wxyz") => ({
  id: `c-${provider}`,
  provider,
  scope: "repository",
  last4,
  created_at: "2026-10-01T10:00:00.000Z",
});

describe("Repository settings", () => {
  it("shows the effective settings, where they come from and the state of the repository file", async () => {
    serveRepo();
    renderApp("/repos/repo-1/settings");

    expect(
      await screen.findByRole("heading", { level: 1, name: "acme/api settings" }),
    ).toBeVisible();
    expect(screen.getByLabelText("Enforcement mode")).toHaveValue("warn");
    expect(screen.getByLabelText("Provider")).toHaveValue("deepseek");
    expect(screen.getByLabelText("Model")).toHaveValue("m-1");
    expect(screen.getByLabelText("Minimum confidence (0 to 1)")).toHaveValue(0.8);
    expect(screen.getByLabelText("Target branches")).toHaveValue("main\nmaster");
    expect(screen.getByLabelText("Security")).toBeChecked();
    expect(screen.getByLabelText("Final Review")).not.toBeChecked();
    expect(screen.getByTestId("repo-file-status")).toHaveAttribute("data-status", "absent");
    expect(screen.getByText(/everything here is set in the dashboard/)).toBeVisible();
    expect(screen.getByText(/wins for the settings it sets/)).toBeVisible();
    // Nothing changed yet, so there is nothing to save.
    expect(screen.getByRole("button", { name: "Save settings" })).toBeDisabled();
  });

  it("shows the settings the repository file sets as read-only, labelled, with the file's state", async () => {
    serveRepo({
      settings: makeSettings({
        repo_file_keys: ["review.mode", "ignore"],
        repo_file: {
          path: ".github/ai-pr-review.yml",
          status: "applied",
          message: "A note about the file.",
        },
      }),
    });
    renderApp("/repos/repo-1/settings");

    const mode = await screen.findByLabelText("Enforcement mode");
    expect(mode).toBeDisabled();
    const field = mode.closest("[data-field]") as HTMLElement;
    expect(within(field).getByText(/Set by/)).toHaveTextContent(".github/ai-pr-review.yml");
    expect(screen.getByLabelText("Ignore patterns")).toBeDisabled();
    // A setting the file does not set stays editable.
    expect(screen.getByLabelText("Minimum severity")).toBeEnabled();
    expect(screen.getByTestId("repo-file-status")).toHaveTextContent("A note about the file.");
    expect(screen.getByText(/Set by the file: review.mode, ignore/)).toBeVisible();
    // Locked fields have no reset.
    expect(within(field).queryByRole("button", { name: /Reset/ })).toBeNull();
  });

  it.each([
    ["invalid", /cannot be used, so it is ignored/],
    ["unavailable", /could not be asked/],
  ] as const)("says when the repository file is %s", async (status, text) => {
    serveRepo({
      settings: makeSettings({
        repo_file: { path: ".github/ai-pr-review.yml", status, message: null },
      }),
    });
    renderApp("/repos/repo-1/settings");
    expect(await screen.findByTestId("repo-file-status")).toHaveTextContent(text);
    expect(screen.getByLabelText("Enforcement mode")).toBeEnabled();
  });

  it("saves only what changed, with the CSRF token, and says it was saved", async () => {
    const calls = serveRepo();
    renderApp("/repos/repo-1/settings");
    const user = userEvent.setup();

    await user.selectOptions(await screen.findByLabelText("Enforcement mode"), "fail_on_threshold");
    await user.click(screen.getByLabelText("Final Review"));
    await user.clear(screen.getByLabelText("Ignore patterns"));
    await user.type(screen.getByLabelText("Ignore patterns"), "dist/**{Enter}docs/**");
    expect(screen.getByText("Unsaved changes (3)")).toBeVisible();
    await user.click(screen.getByRole("button", { name: "Save settings" }));

    await waitFor(() => expect(calls.patches).toHaveLength(1));
    expect(calls.patches[0]!.body).toEqual({
      config: {
        review: { mode: "fail_on_threshold" },
        agents: { final_review: true },
        ignore: ["dist/**", "docs/**"],
      },
    });
    expect(calls.patches[0]!.csrf).toBe("csrf-1");
    expect(await screen.findByText("Settings saved.")).toBeVisible();
    expect(screen.getByRole("button", { name: "Save settings" })).toBeDisabled();
  });

  it("checks the values with the shared schema before sending anything", async () => {
    const calls = serveRepo();
    renderApp("/repos/repo-1/settings");
    const user = userEvent.setup();

    const confidence = await screen.findByLabelText("Minimum confidence (0 to 1)");
    await user.clear(confidence);
    await user.type(confidence, "1.5");
    await user.clear(screen.getByLabelText("Target branches"));
    await user.click(screen.getByRole("button", { name: "Save settings" }));

    const summary = await screen.findByRole("alert");
    expect(summary).toHaveTextContent("These settings cannot be saved yet");
    expect(
      within(summary).getByRole("link", { name: "Minimum confidence (0 to 1)" }),
    ).toHaveAttribute("href", "#setting-review.minimum_confidence");
    expect(within(summary).getByRole("link", { name: "Target branches" })).toBeVisible();
    expect(confidence).toHaveAttribute("aria-invalid", "true");
    expect(confidence).toHaveAccessibleDescription(/Too big|expected number to be <=1|<=1/i);
    expect(calls.patches).toHaveLength(0);

    // Fixing a field clears its message.
    await user.clear(confidence);
    await user.type(confidence, "0.9");
    expect(confidence).not.toHaveAttribute("aria-invalid");
  });

  it("shows what the server refused", async () => {
    serveRepo({
      patchResponse: () =>
        json(
          {
            error: {
              code: "validation_error",
              message: "The request is not valid",
              details: ["base_url: must be a public HTTPS address"],
            },
          },
          400,
        ),
    });
    renderApp("/repos/repo-1/settings");
    const user = userEvent.setup();
    await user.type(
      await screen.findByLabelText("Custom endpoint (optional)"),
      "https://10.0.0.1/v1",
    );
    await user.click(screen.getByRole("button", { name: "Save settings" }));
    expect(await screen.findByText("base_url: must be a public HTTPS address")).toBeVisible();
    // The edit is still there to correct.
    expect(screen.getByLabelText("Custom endpoint (optional)")).toHaveValue("https://10.0.0.1/v1");
  });

  it("resets a stored setting to the inherited value by removing it", async () => {
    const calls = serveRepo();
    renderApp("/repos/repo-1/settings");
    const user = userEvent.setup();

    const mode = (await screen.findByLabelText("Enforcement mode")).closest(
      "[data-field]",
    ) as HTMLElement;
    await user.click(within(mode).getByRole("button", { name: "Reset to inherited or default" }));
    expect(within(mode).getByText(/go back to the inherited or default value/)).toBeVisible();
    expect(screen.getByLabelText("Enforcement mode")).toBeDisabled();
    // Undo puts it back and there is nothing to save again.
    await user.click(within(mode).getByRole("button", { name: "Undo reset" }));
    expect(screen.getByRole("button", { name: "Save settings" })).toBeDisabled();

    await user.click(within(mode).getByRole("button", { name: "Reset to inherited or default" }));
    await user.click(screen.getByRole("button", { name: "Save settings" }));
    await waitFor(() => expect(calls.patches).toHaveLength(1));
    expect(calls.patches[0]!.body).toEqual({ config: { review: { mode: null } } });
    // A setting that is not stored here has no reset.
    const files = screen
      .getByLabelText("Most changed files per review")
      .closest("[data-field]") as HTMLElement;
    expect(within(files).queryByRole("button", { name: /Reset/ })).toBeNull();
  });

  it("turns reviews off with the enabled switch", async () => {
    const calls = serveRepo();
    renderApp("/repos/repo-1/settings");
    const user = userEvent.setup();
    await user.click(await screen.findByLabelText("Review pull requests of this repository"));
    await user.click(screen.getByRole("button", { name: "Save settings" }));
    await waitFor(() => expect(calls.patches).toHaveLength(1));
    expect(calls.patches[0]!.body).toEqual({ enabled: false });
  });

  it("discards changes", async () => {
    serveRepo();
    renderApp("/repos/repo-1/settings");
    const user = userEvent.setup();
    await user.selectOptions(await screen.findByLabelText("Enforcement mode"), "comment_only");
    await user.click(screen.getByRole("button", { name: "Discard changes" }));
    expect(screen.getByLabelText("Enforcement mode")).toHaveValue("warn");
    expect(screen.getByRole("button", { name: "Save settings" })).toBeDisabled();
  });

  it("explains the privacy of the chosen provider, DeepSeek included", async () => {
    serveRepo();
    renderApp("/repos/repo-1/settings");
    const user = userEvent.setup();

    const notice = await screen.findByTestId("provider-notice");
    expect(notice).toHaveTextContent("Privacy: DeepSeek");
    expect(notice).toHaveTextContent("China-based company");
    expect(notice).toHaveTextContent("never sent");

    await user.selectOptions(screen.getByLabelText("Provider"), "anthropic");
    expect(notice).toHaveTextContent("Privacy: Anthropic");
    expect(notice).not.toHaveTextContent("China-based");
    await user.selectOptions(screen.getByLabelText("Provider"), "");
    expect(notice).toHaveTextContent("Choose a provider");
  });

  it("warns before unsaved changes are lost, and lets people stay or leave", async () => {
    serveRepo();
    renderApp("/repos/repo-1/settings");
    const user = userEvent.setup();
    await user.selectOptions(await screen.findByLabelText("Enforcement mode"), "comment_only");

    await user.click(
      within(screen.getByRole("navigation", { name: "Main" })).getByRole("link", { name: "Runs" }),
    );
    const dialog = await screen.findByRole("alertdialog", { name: "Leave without saving?" });
    await user.click(within(dialog).getByRole("button", { name: "Stay on this page" }));
    expect(screen.queryByRole("alertdialog")).toBeNull();
    expect(screen.getByTestId("location")).toHaveTextContent("/repos/repo-1/settings");
    expect(screen.getByLabelText("Enforcement mode")).toHaveValue("comment_only");

    server.use(http.get(`${API}/api/runs`, () => json({ items: [], next_cursor: null })));
    await user.click(
      within(screen.getByRole("navigation", { name: "Main" })).getByRole("link", { name: "Runs" }),
    );
    await user.click(
      within(await screen.findByRole("alertdialog")).getByRole("button", { name: "Leave" }),
    );
    await waitFor(() => expect(screen.getByTestId("location")).toHaveTextContent("/runs"));
  });

  it("does not warn when nothing changed", async () => {
    serveRepo();
    server.use(http.get(`${API}/api/runs`, () => json({ items: [], next_cursor: null })));
    renderApp("/repos/repo-1/settings");
    const user = userEvent.setup();
    await screen.findByLabelText("Enforcement mode");
    await user.click(
      within(screen.getByRole("navigation", { name: "Main" })).getByRole("link", { name: "Runs" }),
    );
    await waitFor(() => expect(screen.getByTestId("location")).toHaveTextContent("/runs"));
    expect(screen.queryByRole("alertdialog")).toBeNull();
  });

  it("shows a viewer everything, read-only, with the reason", async () => {
    const calls = serveRepo({
      role: "viewer",
      settings: makeSettings({ repo_file_keys: ["ignore"] }),
    });
    renderApp("/repos/repo-1/settings");

    expect(await screen.findByRole("note")).toHaveTextContent("only an admin can change them");
    for (const label of [
      "Enforcement mode",
      "Provider",
      "Model",
      "Target branches",
      "Security",
      "Instructions for the reviewers",
    ]) {
      expect(screen.getByLabelText(label)).toBeDisabled();
    }
    expect(screen.getByLabelText("Review pull requests of this repository")).toBeDisabled();
    expect(screen.queryByRole("button", { name: "Save settings" })).toBeNull();
    expect(screen.queryByRole("button", { name: /Reset/ })).toBeNull();
    // Keys are admin-only: the panel explains instead of failing, and the keys are never requested.
    expect(screen.getByText(/Provider keys are managed by admins/)).toBeVisible();
    expect(screen.queryByRole("button", { name: "Add key" })).toBeNull();
    expect(screen.queryByRole("link", { name: "Download CSV" })).toBeNull();
    expect(calls.patches).toHaveLength(0);
  });

  it("says when the repository does not exist for this person", async () => {
    signedInAs();
    server.use(
      http.get(`${API}/api/repos/repo-1`, () => apiError(404, "not_found")),
      http.get(`${API}/api/repos/repo-1/settings`, () => apiError(404, "not_found")),
    );
    renderApp("/repos/repo-1/settings");
    expect(await screen.findByText("Repository not found")).toBeVisible();
  });
});

describe("Provider keys", () => {
  it("shows which providers have a key by its last four characters, and never the key", async () => {
    serveRepo({ credentials: [credential("deepseek", "wxyz")] });
    renderApp("/repos/repo-1/settings");

    const list = await screen.findByRole("list", { name: "Provider keys" });
    const deepseek = within(list)
      .getAllByRole("listitem")
      .find((li) => li.getAttribute("data-provider") === "deepseek")!;
    expect(within(deepseek).getByText("wxyz")).toBeVisible();
    expect(within(deepseek).getByRole("button", { name: "Replace key" })).toBeVisible();
    expect(within(deepseek).getByRole("button", { name: "Remove key" })).toBeVisible();
    expect(within(deepseek).getByText(/China-based company/)).toBeVisible();
    const openai = within(list)
      .getAllByRole("listitem")
      .find((li) => li.getAttribute("data-provider") === "openai")!;
    expect(within(openai).getByText("No key set")).toBeVisible();
    expect(within(openai).getByRole("button", { name: "Add key" })).toBeVisible();
  });

  it("tests a key without saving it, then saves it write-only and forgets it", async () => {
    const calls = serveRepo();
    renderApp("/repos/repo-1/settings");
    const user = userEvent.setup();

    const list = await screen.findByRole("list", { name: "Provider keys" });
    const row = within(list)
      .getAllByRole("listitem")
      .find((li) => li.getAttribute("data-provider") === "openai")!;
    await user.click(within(row).getByRole("button", { name: "Add key" }));
    const input = within(row).getByLabelText("API key");
    expect(input).toHaveAttribute("type", "password");
    expect(input).toHaveAttribute("autocomplete", "off");
    expect(within(row).getByRole("button", { name: "Test connection" })).toBeDisabled();

    await user.type(input, "sk-test-0123456789");
    await user.click(within(row).getByRole("button", { name: "Test connection" }));
    expect(await within(row).findByText(/Connected: The provider accepted the key/)).toBeVisible();
    expect(calls.tests).toEqual([{ provider: "openai", api_key: "sk-test-0123456789" }]);
    expect(calls.puts).toEqual([]);

    await user.click(within(row).getByRole("button", { name: "Save key" }));
    await waitFor(() =>
      expect(calls.puts).toEqual([{ provider: "openai", api_key: "sk-test-0123456789" }]),
    );
    // The form closes and the typed key is gone from the page.
    await waitFor(() => expect(within(row).queryByLabelText("API key")).toBeNull());
    expect(document.body.textContent).not.toContain("sk-test-0123456789");
  });

  it("reports a key that does not work", async () => {
    serveRepo();
    server.use(
      http.post(`${API}/api/repos/repo-1/credentials/test`, () =>
        json({ ok: false, message: "The provider rejected the key." }),
      ),
    );
    renderApp("/repos/repo-1/settings");
    const user = userEvent.setup();
    const list = await screen.findByRole("list", { name: "Provider keys" });
    const row = within(list).getAllByRole("listitem")[0]!;
    await user.click(within(row).getByRole("button", { name: "Add key" }));
    await user.type(within(row).getByLabelText("API key"), "sk-bad-0123456789");
    await user.click(within(row).getByRole("button", { name: "Test connection" }));
    expect(
      await within(row).findByText(/Not working: The provider rejected the key/),
    ).toBeVisible();
  });

  it("removes a key only after confirmation", async () => {
    const calls = serveRepo({ credentials: [credential("anthropic", "abcd")] });
    renderApp("/repos/repo-1/settings");
    const user = userEvent.setup();

    const list = await screen.findByRole("list", { name: "Provider keys" });
    const row = within(list)
      .getAllByRole("listitem")
      .find((li) => li.getAttribute("data-provider") === "anthropic")!;
    await user.click(within(row).getByRole("button", { name: "Remove key" }));
    const dialog = await screen.findByRole("alertdialog", { name: "Remove the Anthropic key?" });
    await user.click(within(dialog).getByRole("button", { name: "Cancel" }));
    expect(calls.deletes).toEqual([]);

    await user.click(within(row).getByRole("button", { name: "Remove key" }));
    await user.click(
      within(await screen.findByRole("alertdialog")).getByRole("button", { name: "Remove key" }),
    );
    await waitFor(() => expect(calls.deletes).toEqual(["anthropic"]));
    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
  });
});

describe("Export", () => {
  it("offers a CSV download of runs or findings to admins", async () => {
    serveRepo();
    renderApp("/repos/repo-1/settings");
    const user = userEvent.setup();
    const link = await screen.findByRole("link", { name: "Download CSV" });
    expect(link).toHaveAttribute("href", `${API}/api/repos/repo-1/export?kind=runs`);
    await user.selectOptions(screen.getByLabelText("What to export"), "findings");
    expect(link.getAttribute("href")).toContain("kind=findings");
    await user.type(screen.getByLabelText("From"), "2026-10-01");
    expect(link.getAttribute("href")).toContain("from=");
  });
});

describe("Installation defaults", () => {
  function serveInstallation(role: "admin" | "viewer") {
    const patches: unknown[] = [];
    signedInAs(
      makeMe({
        installations: [{ id: "i1", account_login: "acme", account_type: "organization", role }],
      }),
    );
    server.use(
      http.get(`${API}/api/installations/i1/settings`, () => json(makeInstallationSettings())),
      http.patch(`${API}/api/installations/i1/settings`, async ({ request }) => {
        patches.push(await request.json());
        return json(
          makeInstallationSettings({
            config: { fork_prs: "review" },
            updated_at: "2026-10-05T10:00:00.000Z",
          }),
        );
      }),
      http.get(`${API}/api/installations/i1/credentials`, () => json({ items: [] })),
    );
    return patches;
  }

  it("shows usage today against the daily limits and the retention window", async () => {
    serveInstallation("admin");
    renderApp("/installations/i1/settings");
    expect(
      await screen.findByRole("heading", { level: 1, name: "acme: installation defaults" }),
    ).toBeVisible();
    expect(screen.getByText("50 of 200 reviews")).toBeVisible();
    expect(screen.getByText("500,000 of 2,000,000 tokens")).toBeVisible();
    expect(
      screen.getByRole("progressbar", { name: /Reviews today: 25% of the daily limit used/ }),
    ).toBeVisible();
    expect(screen.getByRole("progressbar", { name: /Tokens today: 25%/ })).toBeVisible();
    expect(screen.getByTestId("retention")).toHaveTextContent("kept for 90 days");
    expect(screen.getByRole("link", { name: "Audit log" })).toHaveAttribute(
      "href",
      "/installations/i1/audit",
    );
  });

  it("saves defaults for admins", async () => {
    const patches = serveInstallation("admin");
    renderApp("/installations/i1/settings");
    const user = userEvent.setup();
    await user.selectOptions(await screen.findByLabelText("Pull requests from forks"), "review");
    await user.click(screen.getByRole("button", { name: "Save settings" }));
    await waitFor(() => expect(patches).toEqual([{ config: { fork_prs: "review" } }]));
    // The installation has no enabled switch and no repository file.
    expect(screen.queryByLabelText("Review pull requests of this repository")).toBeNull();
  });

  it("is read-only for members, with no audit link", async () => {
    serveInstallation("viewer");
    renderApp("/installations/i1/settings");
    expect(await screen.findByRole("note")).toHaveTextContent("only an admin can change them");
    expect(screen.getByLabelText("Pull requests from forks")).toBeDisabled();
    expect(screen.queryByRole("button", { name: "Save settings" })).toBeNull();
    expect(screen.queryByRole("link", { name: "Audit log" })).toBeNull();
    expect(screen.getByText("50 of 200 reviews")).toBeVisible();
  });
});
