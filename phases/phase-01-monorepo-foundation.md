# Phase 1 – Monorepo Foundation

**Depends on:** Phase 0  
**Unblocks:** Phases 2, 5, 6  
**Refs:** PL-16, PL-17, design §2, §3

## Goal

Turn the existing Action-based repo into a multi-package workspace, keep every piece of reusable code and its tests, and make the full local stack (PostgreSQL, Redis, api, worker, web) start with one command.

## Starting point

Commit `b77c898` already has: config schema (zod), shared types, pure routing guards, Octokit client wrapper with retry and throttling, logger, JSON-schema generation, and tests. See the migration table in design §2.

## Tasks

### Workspace
- [ ] Convert to npm workspaces: `apps/api`, `apps/worker`, `apps/web`, `packages/shared`, `packages/core`, `packages/db`.
- [ ] Root `tsconfig.base.json` (strict), per-package `tsconfig.json` with project references or path aliases.
- [ ] Shared ESLint, Prettier and Vitest config; keep the current rules.

### Migrate existing code
- [ ] `src/types/*` → `packages/shared` (add `RunStatus`, run and agent-run types from design §10).
- [ ] `src/config/*` and `schemas/*` → `packages/shared`. Change `fork_prs` to `skip | review`; replace `coverage.lcov_path` with `coverage.artifact_name` + `lcov_path` (path inside the artifact); mark `provider`, `model`, `base_url` and `limits` as dashboard-only (design §6) by splitting the schema into `sensitiveConfigSchema` and `repoConfigSchema`.
- [ ] `src/events/guards.ts` → `packages/core/routing` (`decide()` follows `fork_prs`). Keep its tests.
- [ ] `src/github/client.ts` → `packages/core/github`: drop `@actions/github`/`@actions/core`; build on `@octokit/core` with the retry and throttling plugins.
- [ ] `src/util/logger.ts` → `packages/shared`; keep secret redaction; add fields `runId`, `repo`, `prNumber`.
- [ ] Move tests next to the code they cover; all existing tests must pass or be consciously rewritten.

### Retire the Action
- [ ] Remove `action.yml`, `dist/`, `scripts/build.mjs`, `scripts/local-run.mjs`, `.github/workflows/ai-pr-review.yml`, `examples/workflow.yml`, and the Action-only parts of `src/main.ts` and `src/events/router.ts` (their logic is rewritten in Phase 3).
- [ ] Keep `examples/ai-pr-review.yml` as the repo-level config example, updated to the new keys.
- [ ] Update `.github/workflows/ci.yml`: lint, format check, typecheck, test, build; no `dist/` freshness check.

### Local infrastructure
- [ ] `docker-compose.yml` for PostgreSQL and Redis (named volumes, health checks); optional profile for api/worker/web.
- [ ] `.env.example` with every variable from design §6 and comments; never commit real values. Validate env with zod at startup in each app and print only the missing variable names.
- [ ] Stub `apps/api` (Fastify with `/healthz` and `/readyz`), `apps/worker` (starts, connects, idles), `apps/web` (Vite + React hello page).
- [ ] Root scripts: `dev` (all apps), `build`, `test`, `lint`, `typecheck`, `db:up`.
- [ ] README: prerequisites, setup, running locally, repository layout.

## Testing

- Existing config, guard and logger tests pass in their new packages.
- `/healthz` returns 200; `/readyz` reflects DB and Redis state.
- CI is green from a clean checkout.

## Deliverables

- Working workspace with the old logic preserved, no Action entry point, and the local stack running.

## Exit criteria

- `npm run check` passes at the root and in CI.
- `docker compose up` plus `npm run dev` brings up api, worker and web locally.
- No reference to `@actions/*` remains.

## Risks

- Moving files can silently drop tests. Compare the test list before and after the move.
- Over-engineering the build setup. Prefer plain `tsc`/`tsx` for backend packages and Vite for web.
