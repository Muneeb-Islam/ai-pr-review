# Decision Log

Recorded 2026-10-01 (decisions 1–10) and 2026-10-02 (decisions 11–20, scope change to a platform). "Assumed" means chosen by default and still open to change.

## Original decisions (2026-10-01)

| # | Decision | Answer | Status |
|---|---|---|---|
| 1 | Distribution | Public, multi-user product | Confirmed (revised by 13) |
| 2 | Provider | **DeepSeek** primary; Anthropic and OpenAI also supported | Confirmed |
| 3 | Execution policy | PRs targeting `main` or `master` only | Confirmed. Now the default of a per-repo `target_branches` setting. |
| 4 | Enforcement default | `comment_only` | Confirmed |
| 5 | Language scope | Node.js/TypeScript only | Confirmed |
| 6 | Coverage source | LCOV (Jest/Vitest) only | Confirmed. Now read from a GitHub Actions artifact (decision 19). |
| 7 | Security tooling | AI-only; `ScannerAdapter` interface only | Confirmed |
| 8 | Sandbox repo | A sandbox for end-to-end tests is needed. The GitHub App (Phase 3) must be installed on a sandbox repo. | Procedure documented in `github-app-setup.md` (Phase 3). Closes when the owner creates the repo and installs the App; record its name here. |
| 9 | Coding agent | Claude Code, one phase per session | Confirmed |
| 10 | Action / repo name | Placeholder `ai-pr-review-assistant`, kept in one place | Deferred |

## Scope change (2026-10-02)

The project grows from a stateless GitHub Action to a platform with a backend, history and dashboard. See `scope.md`.

| # | Decision | Answer | Status |
|---|---|---|---|
| 11 | Architecture | **GitHub App + backend**: webhooks → queue → worker → GitHub. The backend owns the review lifecycle. | Confirmed |
| 12 | Database | **PostgreSQL** | Confirmed |
| 13 | Tenancy | **Multi-user with GitHub login**; users see only repos they can access | Confirmed |
| 14 | Frontend | **React + Vite** single-page app calling the backend API | Confirmed |
| 15 | Backend stack | Node.js/TypeScript, **Fastify**, **Drizzle ORM**, **Redis + BullMQ**, **npm workspaces** monorepo, Vitest, zod | Assumed. npm matches the existing repo; Fastify/Drizzle/BullMQ are the proposals. |
| 16 | Provider keys | **Bring-your-own-key**, stored encrypted per installation (optional per-repo override) | Assumed |
| 17 | Billing | Out of scope; per-installation quotas only | Assumed |
| 18 | Hosting | Docker Compose first (api, worker, web, Postgres, Redis); cloud choice later | Assumed |
| 19 | Coverage input | LCOV from a GitHub Actions artifact (needs `actions: read`); the App never checks out code | Assumed |
| 20 | Fork PRs | Reviewable via API only (no code executed, keys server-side). Default `skip`; admin opts in per repo. | Assumed |
| 21 | Retention and storage | 90-day default retention; no diffs or source files stored; short evidence excerpts only | Assumed |
| 22 | Config precedence | defaults < dashboard < `.github/ai-pr-review.yml` from the **base branch** (non-sensitive keys only). `provider`, `base_url`, credentials and limits are dashboard-only. | Assumed |
| 23 | Existing Action code | Phase 1 of the old plan (committed as `b77c898`) is migrated into `packages/` (config schema, types, guards, GitHub client, logger, tests). The Action entry point (`action.yml`, `dist/`, Action workflow) is retired. | Confirmed by scope change |

## Consequences worth remembering

- **Fork safety changes shape.** The old Action had to avoid secrets on forks. The App holds keys on the server and never executes PR code, so fork review is technically safe. The remaining risks are cost abuse and prompt injection from strangers, handled by opt-in plus quotas.
- **Config from the base branch only.** A PR author must not be able to change review instructions, provider or `base_url` through the PR itself.
- **`base_url` is an SSRF surface.** Dashboard-only, HTTPS only, private and link-local addresses rejected.
- **Coverage depends on CI.** If the artifact is missing at review time, coverage is reported as "not measured". A later `workflow_run` re-evaluation is a stretch goal (Phase 11).
- **Visible `skipped` runs.** Guard decisions create a run with a reason so users can answer "why wasn't my PR reviewed?".

## Provider notes (DeepSeek)

- **API shape:** OpenAI-compatible chat completions at a configurable base URL.
- **Structured output:** JSON mode, no strict schema enforcement. Every response is validated by our schema with one repair retry (Phases 6 and 7).
- **Model IDs:** configuration only; confirm current names in DeepSeek's documentation when writing example config.
- **Privacy:** the hosted DeepSeek API is operated by a China-based company. State this in the dashboard (provider selection screen), README and `docs/privacy.md`, and log which provider receives code. Users who cannot accept it choose another provider.
- **Rate limits and latency:** can be spiky; rely on retry, backoff and the concurrency limiter.

## Open items

- Confirm assumed decisions 15–22.
- Repo/product name (decision 10).
- Default model ID for example config (DeepSeek docs check, Phase 6).
- Production hosting target (decision 18).
