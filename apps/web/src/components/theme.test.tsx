// Light and dark themes following the system setting, with a toggle (phase 10, app shell) and keyboard use.
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { applyTheme, initTheme, readStoredTheme, resolveTheme } from "../lib/theme";
import { http } from "msw";
import { API, makeRepo } from "../test/fixtures";
import { json, renderApp, signedInAs } from "../test/render";
import { server } from "../test/server";
import { ThemeToggle } from "./ThemeToggle";

const isDark = () => document.documentElement.classList.contains("dark");

function stubSystem(dark: boolean) {
  const listeners = new Set<() => void>();
  const query = {
    matches: dark,
    media: "(prefers-color-scheme: dark)",
    addEventListener: (_: string, l: () => void) => listeners.add(l),
    removeEventListener: (_: string, l: () => void) => listeners.delete(l),
  };
  window.matchMedia = (() => query) as unknown as typeof window.matchMedia;
  return {
    set(next: boolean) {
      query.matches = next;
      listeners.forEach((l) => l());
    },
  };
}

afterEach(() => vi.unstubAllGlobals());

describe("theme", () => {
  it("follows the system setting until a choice is made", () => {
    const system = stubSystem(true);
    const stop = initTheme();
    expect(isDark()).toBe(true);
    system.set(false);
    expect(isDark()).toBe(false);
    stop();
  });

  it("uses the stored choice over the system setting", () => {
    stubSystem(true);
    window.localStorage.setItem("aipr-theme", "light");
    initTheme();
    expect(isDark()).toBe(false);
  });

  it("falls back to the system setting when storage is unavailable", () => {
    stubSystem(false);
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    expect(readStoredTheme()).toBe("system");
    vi.restoreAllMocks();
  });

  it("resolves 'system' from the media query", () => {
    stubSystem(true);
    expect(resolveTheme("system")).toBe("dark");
    expect(resolveTheme("light")).toBe("light");
    applyTheme("system");
    expect(isDark()).toBe(true);
  });
});

describe("ThemeToggle", () => {
  it("cycles system, light, dark, applies each and remembers it", async () => {
    stubSystem(false);
    applyTheme("system");
    render(<ThemeToggle />);
    const user = userEvent.setup();

    const button = () => screen.getByRole("button", { name: /^Theme:/ });
    expect(button()).toHaveAccessibleName("Theme: System. Switch to light.");

    await user.click(button());
    expect(button()).toHaveAccessibleName("Theme: Light. Switch to dark.");
    expect(isDark()).toBe(false);

    await user.click(button());
    expect(button()).toHaveAccessibleName("Theme: Dark. Switch to system.");
    expect(isDark()).toBe(true);
    expect(window.localStorage.getItem("aipr-theme")).toBe("dark");

    await user.click(button());
    expect(button()).toHaveAccessibleName("Theme: System. Switch to light.");
    expect(isDark()).toBe(false);
  });
});

describe("keyboard use", () => {
  it("reaches the skip link first, then the navigation, in a sensible order", async () => {
    signedInAs();
    server.use(
      http.get(`${API}/api/repos`, () => json({ items: [makeRepo({ full_name: "acme/api" })] })),
    );
    renderApp("/repos");
    await screen.findByRole("link", { name: /acme\/api/ });
    const user = userEvent.setup();

    await user.tab();
    expect(screen.getByRole("link", { name: /skip to content/i })).toHaveFocus();
    await user.tab();
    expect(screen.getByRole("link", { name: "AI PR Review" })).toHaveFocus();
    for (const name of ["Repos", "Runs", "Findings", "Analytics"]) {
      await user.tab();
      expect(
        within(screen.getByRole("navigation", { name: "Main" })).getByRole("link", { name }),
      ).toHaveFocus();
    }
  });

  it("opens the account menu and chooses an item with the keyboard alone", async () => {
    signedInAs();
    server.use(http.get(`${API}/api/repos`, () => json({ items: [] })));
    renderApp("/repos");
    const trigger = await screen.findByRole("button", { name: /account menu for octocat/i });
    const user = userEvent.setup();

    trigger.focus();
    await user.keyboard("{Enter}");
    const account = await screen.findByRole("menuitem", { name: "Account" });
    expect(account).toBeVisible();
    await user.keyboard("{Enter}");
    expect(await screen.findByRole("heading", { name: "Account", level: 1 })).toBeVisible();
  });

  it("closes the account menu with Escape and returns focus to its button", async () => {
    signedInAs();
    server.use(http.get(`${API}/api/repos`, () => json({ items: [] })));
    renderApp("/repos");
    const trigger = await screen.findByRole("button", { name: /account menu for octocat/i });
    const user = userEvent.setup();
    await user.click(trigger);
    await screen.findByRole("menu");
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("menu")).toBeNull();
    expect(trigger).toHaveFocus();
  });
});
