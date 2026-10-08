import { NavLink, Outlet, useLocation } from "react-router";
import { AccountMenu } from "../components/AccountMenu";
import { LiveIndicator } from "../components/LiveIndicator";
import { Onboarding } from "../components/Onboarding";
import { ThemeToggle } from "../components/ThemeToggle";
import type { Me } from "../hooks/queries";
import { useRunEvents } from "../hooks/useRunEvents";

const NAV = [
  { to: "/repos", label: "Repos" },
  { to: "/runs", label: "Runs" },
  { to: "/findings", label: "Findings" },
  { to: "/analytics", label: "Analytics" },
];

const navClass = ({ isActive }: { isActive: boolean }) =>
  `rounded px-3 py-2 text-sm font-medium whitespace-nowrap no-underline ${
    isActive ? "bg-surface-2 text-fg" : "text-muted hover:bg-surface-2 hover:text-fg"
  }`;

/**
 * The shell of the signed-in app: navigation, live-update status, theme and account menu. The live stream is
 * opened here once, so every page below it refreshes as runs change.
 */
export function AppLayout({ me }: { me: Me }) {
  const live = useRunEvents();
  const { pathname } = useLocation();
  const needsInstall = me.installations.length === 0 && pathname !== "/account";

  return (
    <div className="flex min-h-screen flex-col">
      <a
        href="#main"
        className="bg-accent text-accent-fg sr-only z-30 rounded px-3 py-2 focus:not-sr-only focus:absolute focus:top-2 focus:left-2"
      >
        Skip to content
      </a>
      <header className="border-border bg-surface border-b">
        <div className="mx-auto flex max-w-6xl flex-wrap items-center gap-x-4 gap-y-2 px-4 py-2">
          <NavLink to="/" className="text-fg text-base font-bold no-underline" end>
            AI PR Review
          </NavLink>
          <nav
            aria-label="Main"
            className="order-last -mx-1 flex w-full overflow-x-auto sm:order-none sm:mx-0 sm:w-auto"
          >
            {NAV.map((item) => (
              <NavLink key={item.to} to={item.to} className={navClass}>
                {item.label}
              </NavLink>
            ))}
          </nav>
          <div className="ml-auto flex items-center gap-3">
            <LiveIndicator status={live} />
            <ThemeToggle />
            <AccountMenu me={me} />
          </div>
        </div>
      </header>
      <main id="main" tabIndex={-1} className="mx-auto w-full max-w-6xl flex-1 px-4 py-6">
        {needsInstall ? <Onboarding me={me} /> : <Outlet />}
      </main>
    </div>
  );
}
