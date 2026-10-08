import { useSyncExternalStore } from "react";

export type ThemePreference = "system" | "light" | "dark";
export type ResolvedTheme = "light" | "dark";

const STORAGE_KEY = "aipr-theme";
const listeners = new Set<() => void>();

const isPreference = (value: unknown): value is ThemePreference =>
  value === "system" || value === "light" || value === "dark";

/** localStorage can throw (private windows, blocked storage): the theme then just follows the system. */
export function readStoredTheme(): ThemePreference {
  try {
    const stored = window.localStorage.getItem(STORAGE_KEY);
    return isPreference(stored) ? stored : "system";
  } catch {
    return "system";
  }
}

const systemQuery = (): MediaQueryList | undefined =>
  typeof window.matchMedia === "function"
    ? window.matchMedia("(prefers-color-scheme: dark)")
    : undefined;

export function resolveTheme(preference: ThemePreference): ResolvedTheme {
  if (preference !== "system") return preference;
  return systemQuery()?.matches ? "dark" : "light";
}

let preference: ThemePreference = "system";

/** Sets the `dark` class on <html>. Called before the first render so there is no flash of the wrong theme. */
export function applyTheme(next: ThemePreference = preference): void {
  preference = next;
  document.documentElement.classList.toggle("dark", resolveTheme(next) === "dark");
  listeners.forEach((listener) => listener());
}

export function setTheme(next: ThemePreference): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, next);
  } catch {
    // The choice then lasts for this page view only.
  }
  applyTheme(next);
}

/** Reads the stored choice, applies it and follows the system setting while the choice is "system". */
export function initTheme(): () => void {
  applyTheme(readStoredTheme());
  const query = systemQuery();
  const onChange = () => {
    if (preference === "system") applyTheme("system");
  };
  query?.addEventListener("change", onChange);
  return () => query?.removeEventListener("change", onChange);
}

const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};

export function useThemePreference(): ThemePreference {
  return useSyncExternalStore(subscribe, () => preference);
}

export const NEXT_THEME: Record<ThemePreference, ThemePreference> = {
  system: "light",
  light: "dark",
  dark: "system",
};
