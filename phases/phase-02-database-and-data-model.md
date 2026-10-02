# Phase 2 – Database & Data Model

**Depends on:** Phase 1  
**Unblocks:** Phases 3, 4, 8  
**Refs:** PL-04, PL-07, PL-08, design §5, §9

## Goal

A migrated PostgreSQL schema and a tenant-scoped data-access layer that every app uses, so isolation is enforced in one place.

## Tasks

### Schema and migrations
- [x] Add `packages/db` with Drizzle ORM and drizzle-kit migrations.
- [x] Implement the tables in design §5: `users`, `sessions`, `installations`, `user_installations`, `repositories`, `repo_settings`, `provider_credentials`, `webhook_deliveries`, `review_runs`, `agent_runs`, `findings`, `posted_comments`, `finding_feedback`, `audit_log`.
- [x] Enums or checked columns for run status, agent, severity, category, feedback verdict, installation status.
- [x] Foreign keys with sensible `ON DELETE` rules (deleting a run removes its agent runs, findings and posted comments).
- [x] Indexes from design §5; add partial index on active runs (`queued`, `running`) for the sweeper and queue views.
- [x] Unique constraints: `webhook_deliveries.delivery_id`, `installations.github_installation_id`, `repositories(installation_id, github_repo_id)`.
- [x] Seed script with a demo installation, repos, runs and findings for dashboard development.

### Data access layer
- [x] Repository functions per aggregate (installations, repos, settings, runs, agent runs, findings, comments, feedback, audit).
- [x] **Every tenant read/write takes the caller's installation IDs** (or a single installation ID). No exported unscoped query for tenant tables except in a clearly named `system` module used by the worker and cleanup jobs.
- [x] Run state transitions go through one function that enforces the lifecycle in scope §5.1 (for example `completed` cannot go back to `running`) and records timestamps.
- [x] Pagination helper (cursor on `queued_at, id`).
- [x] Retention helper `deleteRunsOlderThan(days)`.

### Data minimisation
- [x] No column for diffs or file contents. `findings.evidence` is limited to 500 characters at the data layer.
- [x] `provider_credentials` exposes only `last4`, provider and metadata to callers; ciphertext is returned only by the worker-side function.

## Testing

- Run migrations from empty to latest in CI against a real PostgreSQL.
- Tenant isolation: data created for installation A is never returned by queries scoped to B (every repository function).
- Illegal state transitions throw; legal ones set `started_at` / `finished_at`.
- Cursor pagination returns stable, complete pages.
- Retention deletes runs and their children only.

## Deliverables

- `packages/db` with schema, migrations, seed script and tenant-scoped access functions.

## Exit criteria

> Status: both criteria pass locally against PostgreSQL 17 (docker-compose): migrations apply from an empty database (every test file creates a fresh database and migrates it), `npm run db:migrate` and `npm run db:seed` run against the compose database, and all isolation, lifecycle, pagination and retention tests pass (`npm run check` is green). **Not verified:** the new CI wiring (Postgres service container and the migrate and seed steps in `.github/workflows/ci.yml`) has not run on GitHub yet. Local note: ports 5432 and 6379 were taken by locally installed services, so the compose Postgres ran on 5544 through the new `POSTGRES_PORT` variable (git-ignored `.env`); Redis was not started because Phase 2 does not need it.

- Migrations apply cleanly forward on a fresh database; the seed loads.
- All isolation and lifecycle tests pass.

## Risks

- Unscoped queries creeping in later. Mitigation: only the `system` module is unscoped; add a lint rule or review checklist item.
- Schema churn after Phase 8. Keep migrations small and reversible. (drizzle-kit migrations are forward-only; "reversible" here means small, reviewable steps. There are no down migrations.)
