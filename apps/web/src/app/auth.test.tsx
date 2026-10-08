// The auth guard, sign-in screen, onboarding and sign-out (UI-01), against a mock API.
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http } from "msw";
import { describe, expect, it } from "vitest";
import { API, makeMe, makeRepo } from "../test/fixtures";
import { apiError, json, renderApp, signedInAs } from "../test/render";
import { server } from "../test/server";
import { queryKeys } from "../hooks/queries";

const repos = (items = [makeRepo({ full_name: "acme/api" })]) =>
  server.use(http.get(`${API}/api/repos`, () => json({ items })));

const location = () => screen.getByTestId("location").textContent;

describe("signed out", () => {
  it("sends a visitor to the login page, remembering where they wanted to go", async () => {
    signedInAs(null);
    renderApp("/runs?repo=r1");
    const link = await screen.findByRole("link", { name: /sign in with github/i });
    expect(location()).toBe("/login");
    expect(link).toHaveAttribute(
      "href",
      `${API}/auth/github/login?return_to=${encodeURIComponent("/runs?repo=r1")}`,
    );
  });

  it("explains a failed sign-in in plain words", async () => {
    signedInAs(null);
    renderApp("/login?error=access_denied");
    expect(await screen.findByRole("alert")).toHaveTextContent(/did not give access/i);
  });

  it("does not trust a return path that leaves the site", async () => {
    signedInAs(null);
    renderApp("/login?return_to=//evil.example/x");
    const link = await screen.findByRole("link", { name: /sign in with github/i });
    expect(link).toHaveAttribute("href", `${API}/auth/github/login?return_to=%2Frepos`);
  });
});

describe("signed in", () => {
  it("shows the repositories and skips the login page", async () => {
    signedInAs();
    repos();
    renderApp("/login");
    expect(await screen.findByRole("link", { name: /acme\/api/ })).toBeVisible();
    expect(location()).toBe("/repos");
  });

  it("offers to install the app when nothing is installed (UI-01)", async () => {
    signedInAs(makeMe({ installations: [] }));
    renderApp("/repos");
    const install = await screen.findByRole("link", { name: /install the github app/i });
    expect(install).toHaveAttribute(
      "href",
      "https://github.com/apps/ai-pr-review/installations/new",
    );
    expect(install).toHaveAttribute("target", "_blank");
    expect(install).toHaveAttribute("rel", expect.stringContaining("noopener"));
    expect(screen.getByRole("link", { name: /sign in again/i })).toBeVisible();
  });

  it("has a main navigation with the four areas, and marks the current one", async () => {
    signedInAs();
    repos();
    renderApp("/repos");
    const nav = await screen.findByRole("navigation", { name: "Main" });
    const links = Array.from(nav.querySelectorAll("a")).map((a) => a.textContent);
    expect(links).toEqual(["Repos", "Runs", "Findings", "Analytics"]);
    expect(screen.getByRole("link", { name: "Repos" })).toHaveAttribute("aria-current", "page");
  });

  it("has a skip link to the main content", async () => {
    signedInAs();
    repos();
    renderApp("/repos");
    const skip = await screen.findByRole("link", { name: /skip to content/i });
    expect(skip).toHaveAttribute("href", "#main");
    expect(document.getElementById("main")).toBeInTheDocument();
  });

  it("handles an unknown page", async () => {
    signedInAs();
    renderApp("/nowhere");
    expect(await screen.findByRole("heading", { name: /page not found/i })).toBeVisible();
  });
});

describe("session end", () => {
  it("goes to the login page with a message when a request says the session is over", async () => {
    signedInAs();
    repos();
    const { queryClient } = renderApp("/repos");
    await screen.findByRole("link", { name: /acme\/api/ });

    // Idle timeout: the next refresh of anything is a 401, and so is "who am I".
    server.use(
      http.get(`${API}/api/repos`, () => apiError(401, "unauthorized", "Sign in to continue")),
      http.get(`${API}/api/me`, () => apiError(401, "unauthorized", "Sign in to continue")),
    );
    await queryClient.invalidateQueries({ queryKey: queryKeys.repos });

    expect(await screen.findByText(/your session ended/i)).toBeVisible();
    expect(location()).toBe("/login");
  });
});

describe("account menu", () => {
  it("signs out with the CSRF token, clears the screen and returns to the login page", async () => {
    signedInAs();
    repos();
    let csrf: string | null = null;
    server.use(
      http.post(`${API}/auth/logout`, ({ request }) => {
        csrf = request.headers.get("x-csrf-token");
        return json({ ok: true });
      }),
    );
    renderApp("/repos");
    const user = userEvent.setup();

    await user.click(await screen.findByRole("button", { name: /account menu for octocat/i }));
    // After sign-out the session is gone: "who am I" says 401.
    signedInAs(null);
    await user.click(await screen.findByRole("menuitem", { name: /sign out/i }));

    await screen.findByRole("link", { name: /sign in with github/i });
    expect(location()).toBe("/login");
    expect(csrf).toBe("csrf-1");
    await waitFor(() => expect(screen.queryByRole("link", { name: /acme\/api/ })).toBeNull());
  });
});
