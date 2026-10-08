# @ai-pr-review/db

Drizzle ORM schema, migrations and the data-access layer for PostgreSQL. Design: `docs/design.md` §5 (data model) and §9 (security model).

## Entry points

| Import                    | What it is                                                                                           | Who may use it               |
| ------------------------- | ---------------------------------------------------------------------------------------------------- | ---------------------------- |
| `@ai-pr-review/db`        | `createDb`, `runMigrations`, **tenant-scoped functions**, lifecycle helpers, errors                  | api, worker                  |
| `@ai-pr-review/db/system` | The only **unscoped** queries (webhooks, worker, retention, sessions, user access cache, ciphertext) | api (webhooks, auth), worker |
| `@ai-pr-review/db/schema` | Raw Drizzle tables                                                                                   | `packages/db` only           |

ESLint enforces this (`eslint.config.mjs`): apps and other packages cannot import `db/schema` or `drizzle-orm`, and `apps/web`, `core` and `shared` cannot import the db package at all.

## Tenant isolation rules

- **Reads** take `installationIds` (the caller's accessible installations, from `system.listAccessibleInstallationIds`) as the second argument. An empty or malformed list matches nothing.
- **Writes** take the single `installationId` they act on as the second argument and never touch another installation's rows. A row that is missing and a row that belongs to someone else are indistinguishable (`NotFoundError` or an empty result).
- Child tables carry `installation_id` and use composite foreign keys, so the database refuses cross-installation links even for code that bypasses this layer.
- Provider key ciphertext is returned only by `system.getProviderCredentialForWorker` (and, for key rotation, `system.listCredentialsForRotation`); tenant functions return `CredentialInfo` (provider, `last4`, metadata).
- The caller scope comes from the user access cache (`user_installations`, `user_repositories`, filled by the auth module at sign-in and re-verified on use). Installation ids scope the tenant queries; whether a user may see a given repository is decided from `user_repositories` before a repository-level query runs.
- Run status changes only through `transitionRun` (lifecycle in `src/lifecycle.ts`, scope §5.1). It is one conditional `UPDATE`, so racing writers cannot both win.

### Row-level security (the second wall, Phase 15)

Every table that carries `installation_id` (and `installations`) has a policy, `tenant_scope` (migration `0006`): a session sees a row only if it announced `aipr.scope = system` or its transaction named the row's installation (`aipr.installation_ids`). With neither it sees nothing.

- `createDb(url)` is the **system** pool: it announces the system scope on every connection (worker, webhooks, jobs). `createDb(url, { scope: "tenant" })` announces nothing; use it for code that acts for a user and run each request in `withInstallationScope(db, installationIds, async (scoped) => ...)`.
- The policies apply only to a role that is not a superuser, has no `BYPASSRLS` and does not own the tables. Development and the test databases connect as a superuser, so there they do nothing; `createAppRoleHandle` (`@ai-pr-review/db/testing`) opens a pool as a plain role, and the api's tests run on it. `getRowSecurityStatus(db)` tells whether a connection is subject to the policies.
- **A new table with `installation_id` needs the policy** in its migration (copy the lines of `0006`); `src/rls.test.ts` fails until it has one.

### Checklist for adding a function

1. Put it in `src/tenant/` (scoped) or, if it truly cannot be scoped to a caller, in `src/system/`.
2. First parameter `db`, second the scope (`installationIds` or `installationId`).
3. Treat malformed ids as "not found"; never let a bad uuid reach Postgres as a 500.
4. Add a case to `src/isolation.test.ts`. The last test in that file fails until you do.
5. Never select the `ciphertext` column outside `src/system/credentials.ts`.

## Migrations

```bash
npm run db:generate   # after editing src/schema.ts; commit the generated SQL in migrations/
npm run db:migrate    # apply to DATABASE_URL
npm run db:seed       # demo installation (replaces the previous demo data)
```

Migrations are forward-only. From the workspace `db:migrate` uses the SQL next to the source; the production image bundles the script (`npm run build:migrate`) and sets `MIGRATIONS_FOLDER`. `MIGRATION_DATABASE_URL` (the owner role) is used instead of `DATABASE_URL` when set, so the role that serves requests need not be the one that creates tables (docs/operations.md, section 6).

## Tests

Tests use a **real PostgreSQL** (no mocks): each test file creates its own empty database from `DATABASE_URL`, migrates it and drops it afterwards. Start the database first with `npm run db:up`.
