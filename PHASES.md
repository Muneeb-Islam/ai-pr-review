# Implementation Phases

AI PR Review Platform: GitHub App + backend (API, queue, worker) + PostgreSQL + React dashboard.

Read first: [docs/scope.md](docs/scope.md) (what we build), [docs/design.md](docs/design.md) (how), [docs/decision-log.md](docs/decision-log.md) (why), [docs/PRD-v0.1.md](docs/PRD-v0.1.md) (original review requirements, `FR-xx`). Acceptance criteria `AC-1`–`AC-12` come from the PRD, `AC-13`–`AC-23` from the scope; platform requirements are `PL-xx` and dashboard requirements `UI-xx`.

## Overview

| Phase | Name | Outcome | Refs |
|---|---|---|---|
| 0 | [Decisions & design](phases/phase-00-decisions-and-design.md) | Scope, decisions and design agreed | scope, design |
| 1 | [Monorepo foundation](phases/phase-01-monorepo-foundation.md) | Existing Action code migrated into a workspace; Postgres + Redis locally; CI | PL-16, PL-17 |
| 2 | [Database & data model](phases/phase-02-database-and-data-model.md) | Schema, migrations, tenant-scoped data access | PL-04, PL-07, PL-08 |
| 3 | [GitHub App & webhooks](phases/phase-03-github-app-and-webhooks.md) | Verified, idempotent webhooks create queued/skipped runs | PL-01–PL-04, PL-06, AC-13–16 |
| 4 | [Auth, API & credentials](phases/phase-04-auth-api-and-credentials.md) | GitHub login, authorisation, settings and encrypted keys | PL-09, PL-10, PL-12, PL-13, PL-15 |
| 5 | [Review engine: context & policy](phases/phase-05-review-engine-context-and-policy.md) | Safe, filtered, size-limited PR context via the GitHub API | FR-06–10, AC-11 |
| 6 | [AI provider layer](phases/phase-06-ai-provider-layer.md) | DeepSeek, Anthropic, OpenAI behind one interface | FR-15, FR-16 |
| 7 | [Agent framework & Code Review agent](phases/phase-07-agent-framework-and-code-review.md) | First agent producing validated findings | FR-11–14, FR-19 |
| 8 | [Queue, worker & run lifecycle](phases/phase-08-queue-worker-and-run-lifecycle.md) | Runs go queued → running → done with history persisted | PL-05–PL-07, PL-11, AC-15 |
| 9 | [GitHub publisher](phases/phase-09-github-publisher.md) | **M1:** PR → review, summary and Check Run, stored in history | FR-17–21, FR-30–33, AC-1–4, AC-16 |
| 10 | [Dashboard foundation](phases/phase-10-dashboard-foundation.md) | **M2:** login, repos, live runs list, run detail | UI-01–04, UI-09, PL-14 |
| 11 | [Test Coverage agent](phases/phase-11-test-coverage-agent.md) | Test gaps and LCOV coverage from Actions artifacts | FR-22–25, AC-5, AC-6 |
| 12 | [Security agent](phases/phase-12-security-agent.md) | **M3:** security findings in summary and Check Run | FR-26–29, AC-7 |
| 13 | [Lifecycle, enforcement & resilience](phases/phase-13-lifecycle-enforcement-resilience.md) | Idempotent reruns, enforcement modes, partial results, final review | FR-34–38, AC-8, 10, 12, 21 |
| 14 | [Dashboard: history, analytics & settings](phases/phase-14-dashboard-history-analytics-settings.md) | **M4:** findings explorer, feedback, settings UI, analytics, re-run | UI-05–08, UI-10, AC-19 |
| 15 | [Hardening, multi-tenancy & operations](phases/phase-15-hardening-multitenancy-operations.md) | Isolation, injection, secret and abuse protections; deployable | AC-9, 17, 18, 20, 22, 23 |
| 16 | [Validation, pilot & release](phases/phase-16-validation-pilot-release.md) | **M5:** all acceptance criteria met, pilot metrics, `v1` | scope §7, §8 |

## Milestones

- **M1 – Vertical slice (end of Phase 9):** open a PR on a sandbox repo → webhook → queued run → worker → inline review, summary and Check Run on the PR → run stored in PostgreSQL. No dashboard yet.
- **M2 – Visible (end of Phase 10):** sign in with GitHub and watch runs go pending → running → done live.
- **M3 – All agents (end of Phase 12):** code review, test coverage and security running.
- **M4 – Feature complete (end of Phase 14):** history, feedback, analytics and settings in the dashboard.
- **M5 – Release (end of Phase 16):** acceptance criteria and pilot metrics met; `v1` tagged.

## Order and parallel work

```
0 ─► 1 ─► 2 ─┬─► 3 ─► 4 ─────────────┐
             └─► 5 ─► 6 ─► 7 ─────────┴─► 8 ─► 9 (M1) ─► 10 (M2) ─► 11 ─► 12 ─► 13 ─► 14 ─► 15 ─► 16
```

- Phases 3–4 (GitHub/auth) and 5–7 (engine) are independent after Phase 2 and can be built in parallel sessions.
- Phase 10 can start against mock API data once Phase 4 exists, but it needs Phases 8–9 for real data.
- The engine (`packages/core`) never touches HTTP or the database, so it can be tested without the platform.

## Status

| Phase | Status |
|---|---|
| 0 | Documents written; waiting for owner review of assumed decisions 15–22 |
| 1 | The old Action-based foundation is committed (`b77c898`). Phase 1 now means migrating it into the monorepo. |
| 2–16 | Not started |

## Acceptance traceability

| AC | Short description | Phase |
|---|---|---|
| 1 | Triggers once per event | 3, 9 |
| 2 | One structured summary | 9, 11, 12 |
| 3 | High-confidence issue → inline comment | 9 |
| 4 | Low-confidence/info → no inline comment | 9 |
| 5 | Missing tests labelled as suggestions | 11 |
| 6 | LCOV coverage reported | 11 |
| 7 | Critical security fixture → summary + Check Run | 12 |
| 8 | Invalid output/timeout → safe partial result | 7, 13 |
| 9 | Fork PRs: no keys, no code execution, skipped unless opted in | 3, 15 |
| 10 | Same-SHA rerun adds no duplicates | 13 |
| 11 | Ignored/generated/lock files excluded and reported | 5 |
| 12 | `fail_on_threshold` fails only at threshold | 13 |
| 13 | Invalid webhook signature rejected | 3 |
| 14 | Duplicate delivery creates one run | 3 |
| 15 | Push supersedes in-flight run | 3, 8, 13 |
| 16 | Pending visible within ~5 s | 3, 9, 10 |
| 17 | Tenant isolation | 4, 15 |
| 18 | Provider keys never exposed, stored encrypted | 4, 15 |
| 19 | Feedback persisted and reflected in metrics | 14 |
| 20 | History filterable; retention cleanup | 14, 15 |
| 21 | Dashboard re-run creates linked run | 13, 14 |
| 22 | Uninstall deactivates installation | 3, 15 |
| 23 | Quotas stop runs with a recorded reason | 8, 15 |

## Out of scope

Billing, platform-paid keys, other Git hosts, executing repository code, auto-fix patches, SSO/SAML, mobile apps, non-JS/TS deep analysis, scanner adapters beyond the interface (full list in [docs/scope.md](docs/scope.md) §4).

## How to hand a phase to an AI

> Read `docs/scope.md`, `docs/design.md`, `docs/decision-log.md` and `phases/phase-XX-….md`. Implement only that phase. Write the tests listed in the phase, run them, and stop when the exit criteria pass. Don't start the next phase.

Run the exit criteria and commit after every phase before starting the next.
