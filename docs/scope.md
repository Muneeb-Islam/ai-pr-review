# Project Scope (v2)

AI PR Review Platform — a GitHub App with a backend, a job queue, a PostgreSQL database and a web dashboard.

This document **supersedes the delivery model of the PRD** (`PRD-v0.1.md`). The PRD's review behaviour (agents, findings, thresholds, GitHub output, security rules) still applies and is reused. What changes is *how it is delivered*: a hosted platform instead of a stateless GitHub Action. Where this document and the PRD disagree, this document wins.

Decisions behind the change are in `decision-log.md`; architecture is in `design.md`.

## 1. Product summary

Developers install the **GitHub App** on their repositories. When a pull request is opened, updated or re-run, the platform:

1. receives a webhook and records a **pending** review run;
2. queues the job and runs specialised review agents (code review, test coverage, security) in a worker;
3. posts inline review comments, one summary comment and a Check Run on the pull request;
4. stores the full run **history** — status, agent runs, findings, warnings, usage — in PostgreSQL;
5. shows everything in a **web dashboard**: repositories, pending/running/finished runs, findings, feedback, settings and analytics.

The assistant stays **advisory by default** (`comment_only`): it never merges, edits repository files or blocks a PR unless a repo explicitly enables a failing Check Run.

## 2. What changed from PRD v0.1

| Topic | PRD v0.1 | Scope v2 |
|---|---|---|
| Delivery | Reusable GitHub Action in each repo's workflow | GitHub App + hosted backend + dashboard |
| Execution | Runs inside the user's GitHub Actions runner | Runs in the platform's worker, triggered by webhooks |
| State | Stateless; hidden markers in comments | PostgreSQL history; markers kept only for idempotency |
| Status visibility | Check Run only | Pending / running / completed / failed live in dashboard and Check Run |
| Config | `.github/ai-pr-review.yml` | Dashboard settings (stored) + optional repo file (overrides non-sensitive keys) |
| API keys | GitHub Actions secret per repo | Bring-your-own-key, stored encrypted per installation or repo |
| Users | Repo admins editing YAML | Multi-user, GitHub login, per-installation access |
| Dashboard / history / analytics | Non-goal | **In scope** |
| Coverage input | LCOV file in the checked-out workspace | LCOV from a GitHub Actions artifact (`actions: read`) |
| Fork PRs | No secrets, no write token | Provider keys are server-side and no PR code is ever executed, so fork PRs can be reviewed. Default stays `skip`; admins opt in per repo. |
| Persistent DB, org reporting | Deferred | **In scope** (history, per-repo and per-installation analytics) |

## 3. Goals

- Install once per account/org through a GitHub App; no workflow file or per-repo secrets.
- Review every eligible PR automatically, with clear **pending → running → done/failed** status in GitHub and in the dashboard.
- Keep the PRD's review quality bar: evidence-backed, schema-validated findings; inline comments only for high-confidence issues; no noisy duplicates.
- Support DeepSeek (primary), Anthropic and OpenAI through one provider interface, with the user's own key.
- Provide a dashboard with history, live status, findings and feedback, settings, and the PRD §13 success metrics.
- Safe multi-tenancy: a user only ever sees repositories they have access to; secrets never leave the server.
- Self-hostable with Docker Compose.

## 4. Non-goals (this release)

- Billing, subscriptions, plans and a platform-paid LLM key (bring-your-own-key only).
- Auto-committing fixes, approving or merging PRs.
- Git hosts other than GitHub.com (GitHub Enterprise Server deferred).
- Running or checking out repository code, running tests, or executing anything from a PR.
- Replacing SAST, dependency scanning, CI or human review.
- Deep analysis for languages other than JavaScript/TypeScript (other text is reviewed by prompt only).
- SSO/SAML, fine-grained custom roles, mobile apps, Slack/Jira/Linear integrations.
- Fine-tuned or self-hosted models (a self-hosted OpenAI-compatible `base_url` is allowed).

## 5. Users and roles

| User | Needs | Access |
|---|---|---|
| Developer | Fast feedback on their PR; see why a PR was or wasn't reviewed | Viewer |
| Reviewer / tech lead | Prioritised findings, history, feedback on quality | Viewer |
| Repo admin | Install the App, configure agents/thresholds/provider key, re-run | Admin (GitHub repo admin or org owner) |
| Platform operator | Deploy, monitor, back up, upgrade the platform | Server access; not a dashboard role |

A user's repositories are the ones granted through installations they can access on GitHub. Admin rights come from their GitHub permission on the repo, not from a separate account system.

## 5.1 Run lifecycle

```
queued ──► running ──► completed
   │          │  ├────► partial   (some agents failed or review limited)
   │          │  ├────► failed    (no usable result)
   │          │  └────► skipped   (guard or size policy)
   └──────────┴──► superseded     (new head SHA arrived)
              └──► cancelled      (user action)
```

`skipped` runs are also recorded when a guard stops a review (draft, fork, too large), with the reason, so users can see why a PR was not reviewed. The Check Run mirrors the state: `queued` → `in_progress` → `completed`.

## 6. Requirements

### 6.1 Review behaviour (inherited from the PRD)

PRD FR-06 to FR-38 apply unchanged unless adapted below: context collection, ignore and secret filtering, size limits, the four agent roles, schema validation, thresholds, inline review + one maintained summary + Check Run, enforcement modes, idempotency and comment lifecycle, and all non-functional requirements.

Adaptations:

| PRD | Adaptation |
|---|---|
| FR-01 | Triggered by GitHub App webhooks (`pull_request` opened/reopened/synchronize/ready_for_review) instead of a workflow. |
| FR-02 | Manual re-run: dashboard button, `/ai-review` PR comment (collaborators only), or the Check Run "Re-run" button. |
| FR-03, FR-04 | Config comes from dashboard settings plus an optional `.github/ai-pr-review.yml` read from the **base branch** (never the PR head). Sensitive keys are dashboard-only. |
| FR-05 | Unchanged: draft PRs are summary-only by default. |
| FR-10 | Also covers stored data: environment values and secrets never reach providers, logs, the database or API responses. |
| FR-22, FR-23 | LCOV is read from a GitHub Actions artifact; if none is available coverage is reported as not measured. |
| FR-31, FR-36, FR-37 | Summary comment and fingerprints still use hidden markers (so reruns are idempotent on GitHub) and are cross-checked against the database. |
| NFR Observability | Run history is queryable in the database; logs remain free of source code and secrets. |

### 6.2 Platform requirements (new)

| ID | Requirement |
|---|---|
| PL-01 | Provide a GitHub App; installing or removing it creates or deactivates the installation and its repositories in the database, including repository add/remove events. |
| PL-02 | The webhook endpoint verifies `X-Hub-Signature-256` on the raw body, rejects invalid signatures, acknowledges quickly and processes asynchronously. |
| PL-03 | Webhook deliveries are idempotent: a repeated delivery ID is processed once. |
| PL-04 | Every eligible event creates a `review_run` in `queued` state before any model call; guard-skipped events create a `skipped` run with a reason. |
| PL-05 | Reviews run in a worker through a durable queue with retries for infrastructure errors, per-installation fairness, global concurrency limits and stuck-job recovery. |
| PL-06 | A new head SHA on the same PR supersedes queued and running runs for older SHAs; superseded runs stop calling models and post nothing stale. |
| PL-07 | Persist per run: status timeline, trigger, head/base SHA, agent runs (status, duration, tokens, retries), findings, suppressed-finding counts by reason, skipped files, warnings, posted GitHub comment IDs, and estimated usage. |
| PL-08 | Do not store full diffs or source files. Store only finding fields (including a short evidence excerpt). Provide a retention setting, default 90 days, with scheduled cleanup. |
| PL-09 | Per-repository settings stored in the database with validation and defaults; precedence: defaults < dashboard < repo file (non-sensitive keys only). |
| PL-10 | Provider API keys are stored encrypted at rest (envelope encryption), accepted write-only, shown only as a last-4 hint, and never logged or returned. |
| PL-11 | Per-installation quotas (runs/day, tokens/day) to bound cost, especially with fork PRs enabled. |
| PL-12 | Authentication through GitHub OAuth; sessions use HttpOnly, Secure, SameSite cookies with CSRF protection. |
| PL-13 | Authorisation: every query is scoped to installations/repos the signed-in user can access; admin actions need GitHub admin rights on the repo or org. |
| PL-14 | Real-time run updates to the dashboard via server-sent events, with polling fallback. |
| PL-15 | Audit log for settings, credential, re-run and cancel actions. |
| PL-16 | Health (`/healthz`), readiness (`/readyz`) and structured logs; database migrations run on deploy. |
| PL-17 | Docker Compose deployment (api, worker, web, PostgreSQL, Redis) with documented environment variables, backup and upgrade steps. |

### 6.3 Dashboard requirements (new)

| ID | Requirement |
|---|---|
| UI-01 | Sign in with GitHub; show an "Install the App" call to action when no installation exists. |
| UI-02 | Repository list with enabled state, last run status and health summary. |
| UI-03 | Runs list with filters (repo, status, branch, author, date, severity) and live status badges for pending/running runs. |
| UI-04 | Run detail: status timeline, trigger, SHAs, link to the PR and Check Run, agent runs, findings, skipped files, warnings, suppressed counts, usage. |
| UI-05 | Findings explorer with severity/category/agent filters and per-finding feedback (useful / false positive / already known), stored for metrics. |
| UI-06 | Repository settings editor: enable/disable, agents, thresholds, enforcement mode, target branches, ignore patterns, fork policy, provider, model, credential management. |
| UI-07 | Analytics: PRD §13 metrics (completion rate, duration, actionable and false-positive rate from feedback, duplicate rate), trends over time, severity mix, usage and estimated cost. |
| UI-08 | Re-run and cancel actions with confirmation and audit entries. |
| UI-09 | Pending/queue view showing queued and running runs across the user's repos. |
| UI-10 | Responsive layout, dark mode, keyboard accessible, readable on mobile. |

## 7. Acceptance criteria

PRD AC-1 to AC-12 still apply, interpreted for the App model (AC-1: triggers once per webhook event; AC-9: fork PRs never receive provider keys or execute code and are skipped unless an admin opts in; AC-10: reruns on the same SHA add no duplicate comments or runs of the same trigger). Additional criteria:

| # | Criterion |
|---|---|
| AC-13 | A webhook with an invalid or missing signature is rejected and creates nothing. |
| AC-14 | Redelivering the same webhook delivery ID creates no second run. |
| AC-15 | A push to an open PR supersedes the in-flight run; no stale inline comments are posted. |
| AC-16 | A new PR shows as pending in the dashboard and as a queued/in-progress Check Run within about 5 seconds of the webhook. |
| AC-17 | A signed-in user can see only repositories they can access; requests for others return 404/403. |
| AC-18 | Provider keys never appear in API responses, logs, prompts or posted comments; they are stored encrypted. |
| AC-19 | Finding feedback is persisted and changes the analytics metrics. |
| AC-20 | Run history stays filterable and complete for the retention window; cleanup removes older data. |
| AC-21 | Re-run from the dashboard creates a linked new run for the same PR and head SHA. |
| AC-22 | Uninstalling the App deactivates the installation: no further runs, data hidden from the dashboard, retention applies. |
| AC-23 | Quotas stop new runs when a per-installation limit is exceeded and record a `skipped` run with the reason. |

## 8. Success metrics

PRD §13 targets remain (completion ≥ 95%, median duration < 5 min, actionable ≥ 70%, false positives < 20%, duplicates < 2%, summary coverage ≥ 90%) and are now measured from the database. Platform targets:

| Metric | Target |
|---|---|
| Webhook accepted → run `queued` | p95 < 3 s |
| `queued` → `running` (normal load) | p95 < 30 s |
| Dashboard reflects a status change | < 5 s |
| API read endpoints | p95 < 500 ms |

## 9. Assumptions (confirm or change)

These were chosen as sensible defaults and are recorded in `decision-log.md` as "assumed".

- Bring-your-own provider key; no platform-paid key and no billing.
- Stack: Node.js/TypeScript throughout, Fastify, Drizzle ORM, PostgreSQL, Redis + BullMQ, React + Vite, npm workspaces (matches the existing repo).
- Docker Compose is the first deployment target; a specific cloud is chosen later.
- Coverage comes from a GitHub Actions artifact, so users must upload one from CI.
- Default retention 90 days; no source stored beyond short evidence excerpts.

## 10. Risks (additions to PRD §16)

| Risk | Mitigation |
|---|---|
| Cross-tenant data leakage | Tenant-scoped data access layer, authorisation tests for every endpoint, optional Postgres row-level security. |
| Provider key theft | Envelope encryption, write-only API, no key in logs, rotation support, SSRF-safe `base_url`. |
| Webhook forgery or replay | Signature verification on the raw body, delivery-ID idempotency. |
| Queue stalls or duplicate processing | Idempotent job handlers, lock renewal, stuck-job recovery, dead-letter queue. |
| GitHub API rate limits across many installations | Per-installation throttling and retry; conditional requests where possible. |
| Cost abuse (fork PR spam, huge PRs) | Per-installation quotas, size limits, fork opt-in. |
| Stored evidence excerpts leak private code | Short excerpts only, retention cleanup, access limited to authorised users, documented in the privacy page. |
| Scope growth (platform is much larger than the Action) | Engine first, dashboard second, strict non-goals list, phase exit criteria. |
