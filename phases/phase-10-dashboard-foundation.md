# Phase 10 – Dashboard Foundation

**Depends on:** Phase 4 (API), Phases 8–9 for real data  
**Unblocks:** Phase 14  
**Milestone:** M2  
**Refs:** UI-01–UI-04, UI-09, UI-10, PL-14, AC-16, design §15

## Goal

A signed-in user can see their repositories and watch runs move from pending to running to done in real time, then open a run to see exactly what happened.

## Tasks

### App shell
- [ ] `apps/web`: React, Vite, React Router, TanStack Query, Tailwind CSS, an accessible component set, light and dark themes following the system setting with a toggle.
- [ ] Typed API client generated from the OpenAPI/zod contracts (Phase 4); one place for base URL, CSRF header and error handling.
- [ ] Auth guard: unauthenticated users go to `/login`; session expiry handled gracefully.
- [ ] Layout: sidebar or top navigation (Repos, Runs, Findings, Analytics), account menu, responsive down to phone width.
- [ ] Shared UI: status badge (queued, running, completed, partial, failed, skipped, superseded, cancelled), severity badge, empty, loading and error states, relative time with exact time on hover.

### Pages
- [ ] **Login / onboarding (UI-01):** "Sign in with GitHub"; if there is no installation, an "Install the GitHub App" call to action with the install URL.
- [ ] **Repositories (UI-02):** list with enabled state, visibility, last run status and time; link to each repo's runs.
- [ ] **Runs list (UI-03, UI-09):** filters for repo, status, branch and date; pending and running runs pinned or highlighted; cursor pagination. A "pending" view shows queued and running runs across the user's repos.
- [ ] **Run detail (UI-04):** status timeline (queued → started → finished with durations), trigger and who triggered it, base/head SHA, links to the PR and Check Run on GitHub, agent runs (status, duration, tokens, warnings), findings list with severity, file and line, skipped files, warnings, suppressed counts, usage.

### Real time (PL-14)
- [ ] Backend: `GET /api/events` SSE stream fed by Redis pub/sub `run.updated`, filtered to the user's accessible repos; heartbeat comments; auth via session cookie.
- [ ] Frontend: a hook that subscribes to SSE and invalidates the affected TanStack Query keys; automatic fallback to polling every few seconds if SSE drops.

### Quality
- [ ] Keyboard navigation, focus states, labelled controls, colour contrast in both themes, no information conveyed by colour alone (badges include text).
- [ ] No secrets or tokens in the client; CSP-compatible (no inline scripts).

## Testing

- Component tests (Testing Library) for badges, filters, run detail rendering for each status.
- API mocking (MSW) for loading, empty and error states.
- SSE hook: update arrives → list refreshes; connection drops → polling fallback.
- Playwright smoke test against the seeded database: sign in (test session), see repos and runs, open a run.
- Manual: open a PR on the sandbox repo and watch the row change in the dashboard (AC-16).

## Deliverables

- Dashboard with login, repositories, runs list, pending view and run detail with live updates.

## Exit criteria

- A new PR appears as pending and updates to running and completed without a page refresh, within about 5 seconds of each change.
- Passes keyboard and basic accessibility checks; works at phone width.

## Risks

- SSE through proxies can buffer; send heartbeats and disable proxy buffering in the deployment config.
- Building pages against mock data hides contract mismatches; use the generated client from day one.
