import { NEXT_THEME, setTheme, useThemePreference, type ThemePreference } from "../lib/theme";
import { MonitorIcon, MoonIcon, SunIcon } from "./icons";

const LABELS: Record<ThemePreference, string> = { system: "System", light: "Light", dark: "Dark" };
const ICONS: Record<ThemePreference, typeof SunIcon> = {
  system: MonitorIcon,
  light: SunIcon,
  dark: MoonIcon,
};

/** Cycles system -> light -> dark. The current choice is in the accessible name and visible on wide screens. */
export function ThemeToggle() {
  const preference = useThemePreference();
  const next = NEXT_THEME[preference];
  const Icon = ICONS[preference];
  return (
    <button
      type="button"
      className="btn"
      onClick={() => setTheme(next)}
      aria-label={`Theme: ${LABELS[preference]}. Switch to ${LABELS[next].toLowerCase()}.`}
      title={`Theme: ${LABELS[preference]}`}
    >
      <Icon className="h-4 w-4" />
      <span className="hidden sm:inline">{LABELS[preference]}</span>
    </button>
  );
}
