# Phase 2 – Database & Data Model

**Depends on:** Phase 1  
**Unblocks:** Phases 3, 4, 8  
**Refs:** PL-04, PL-07, PL-08, design §5, §9

## Goal

A migrated PostgreSQL schema and a tenant-scoped data-access layer that every app uses, so isolation is enforced in one place.

## Tasks

### Schema and migrations
- [ ] Add `packages/db` with Drizzle ORM and drizzle-kit migrations.
- [ ] Implement the tables in design §5: `users`, `sessions`, `installations`, `user_installations`, `repositories`, `repo_settings`, `provider_credentials`, `webhook_deliveries`, `review_runs`, `agent_runs`, `findings`, `posted_comments`, `finding_feedback`, `audit_log`.
- [ ] Enums or checked columns for run status, agent, severity, category, feedback verdict, installation status.
- [ ] Foreign keys with sensible `ON DELETE` rules (deleting a run removes its agent runs, findings and posted comments).
- [ ] Indexes from design §5; add partial index on active runs (`queued`, `running`) for the sweeper and queue views.
- [ ] Unique constraints: `webhook_deliveries.delivery_id`, `installations.github_installation_id`, `repositories(installation_id, github_repo_id)`.
- [ ] Seed script with a demo installation, repos, runs and findings for dashboard development.

### Data access layer
- [ ] Repository functions per aggregate (installations, repos, settings, runs, agent runs, findings, comments, feedback, audit).
- [ ] **Every tenant read/write takes the caller's installation IDs** (or a single installation ID). No exported unscoped query for tenant tables except in a clearly named `system` module used by the worker and cleanup jobs.
- [ ] Run state transitions go through one function that enforces the lifecycle in scope §5.1 (for example `completed` cannot go back to `running`) and records timestamps.
- [ ] Pagination helper (cursor on `queued_at, id`).
- [ ] Retention helper `deleteRunsOlderThan(days)`.

### Data minimisation
- [ ] No column for diffs or file contents. `findings.evidence` is limited to 500 characters at the data layer.
- [ ] `provider_credentials` exposes only `last4`, provider and metadata to callers; ciphertext is returned only by the worker-side function.

## Testing

- Run migrations from empty to latest in CI against a real PostgreSQL.
- Tenant isolation: data created for installation A is never returned by queries scoped to B (every repository function).
- Illegal state transitions throw; legal ones set `started_at` / `finished_at`.
- Cursor pagination returns stable, complete pages.
- Retention deletes runs and their children only.

## Deliverables

- `packages/db` with schema, migrations, seed script and tenant-scoped access functions.

## Exit criteria

- Migrations apply cleanly forward on a fresh database; the seed loads.
- All isolation and lifecycle tests pass.

## Risks

- Unscoped queries creeping in later. Mitigation: only the `system` module is unscoped; add a lint rule or review checklist item.
- Schema churn after Phase 8. Keep migrations small and reversible.
