# AI PR Review Platform

A GitHub App that reviews pull requests with AI agents (code review, test coverage, security), keeps run history in PostgreSQL and shows it in a web dashboard.

> **Status: Phase 2 (database and data model).** The review engine, webhooks and dashboard screens are built in later phases. Today the repo contains the shared types and config schema, the routing guards, the GitHub client, the PostgreSQL schema with tenant-scoped data access, and stub apps that start and report health. See [PHASES.md](PHASES.md) for the plan, [docs/scope.md](docs/scope.md) for what we build and [docs/design.md](docs/design.md) for how.

## Prerequisites

- **Node.js 24 or newer** and npm (workspaces).
- **Docker** with Docker Compose, for local PostgreSQL and Redis.

## Local setup

```bash
npm install
cp .env.example .env     # then adjust values; .env is git-ignored
npm run db:up            # PostgreSQL + Redis, waits until healthy
npm run db:migrate       # apply database migrations
npm run db:seed          # optional: demo installation, repos, runs and findings
npm run dev              # api (3000), worker, web (5173)
```

Check that it works:

```bash
curl http://localhost:3000/healthz   # 200 {"status":"ok"}
curl http://localhost:3000/readyz    # 200 when PostgreSQL and Redis are up, 503 otherwise
```

Open the dashboard stub at http://localhost:5173. Stop the databases with `npm run db:down`.

Each app validates its environment at startup. If something is missing it exits and lists only the **names** of the missing variables. `.env.example` documents every variable.

## Scripts

| Command                       | What it does                                                         |
| ----------------------------- | -------------------------------------------------------------------- |
| `npm run dev`                 | Runs api, worker and web together with prefixed logs                 |
| `npm run build`               | Builds every app (backend: esbuild bundle to `dist/`; web: Vite)     |
| `npm test`                    | Vitest, all workspaces                                               |
| `npm run lint`                | ESLint                                                               |
| `npm run format:check`        | Prettier check (`npm run format` to fix)                             |
| `npm run typecheck`           | `tsc --noEmit` in every package                                      |
| `npm run check`               | lint + format check + typecheck + test + build (what CI runs)        |
| `npm run db:up` / `db:down`   | Start / stop PostgreSQL and Redis                                    |
| `npm run db:migrate`          | Apply pending migrations to `DATABASE_URL` (forward-only)            |
| `npm run db:generate`         | Generate a migration after editing `packages/db/src/schema.ts`       |
| `npm run db:seed`             | Load (or reload) the demo installation for dashboard development     |
| `npm run schema`              | Regenerate `packages/shared/schemas/ai-pr-review.schema.json`        |

## Repository layout

```
apps/
  api/        Fastify server: /healthz, /readyz (webhooks, auth, REST, SSE come later)
  worker/     Queue worker stub: connects to Redis and idles
  web/        React + Vite dashboard stub
packages/
  shared/     types, zod schemas (config, env), logger with redaction, constants
  core/       review engine: routing guards, GitHub client (no HTTP, no database)
  db/         Drizzle schema, migrations, seed, tenant-scoped data access (+ `system` module)
docs/         scope, design, decision log, PRD
phases/       one brief per implementation phase
examples/     ai-pr-review.yml, the repo-level config example
docker-compose.yml   PostgreSQL + Redis for local development
```

Workspace packages export their TypeScript source (`"exports": "./src/index.ts"`), so tests, `tsx` and the bundler use them without a separate build step.

## Configuration

Effective review config = defaults < dashboard settings < an optional `.github/ai-pr-review.yml` read from the PR's **base branch**. `provider`, `model`, `base_url` and `limits` are dashboard-only; a repo file that sets them is rejected. See [examples/ai-pr-review.yml](examples/ai-pr-review.yml) and design §6.

## Privacy note

When DeepSeek is the selected provider, code from reviewed pull requests is sent to DeepSeek's hosted API, operated by a China-based company. Choose another provider if that is not acceptable. See the decision log.
