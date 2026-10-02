# @ai-pr-review/db

Drizzle ORM schema, migrations and the data-access layer for PostgreSQL. Design: `docs/design.md` §5 (data model) and §9 (security model).

## Entry points

| Import                       | What it is                                                                          | Who may use it                  |
| ---------------------------- | ----------------------------------------------------------------------------------- | ------------------------------- |
| `@ai-pr-review/db`           | `createDb`, `runMigrations`, **tenant-scoped functions**, lifecycle helpers, errors | api, worker                     |
| `@ai-pr-review/db/system`    | The only **unscoped** queries (webhooks, worker, retention, user scope, ciphertext) | api (webhooks, auth), worker    |
| `@ai-pr-review/db/schema`    | Raw Drizzle tables                                                                  | `packages/db` only              |

ESLint enforces this (`eslint.config.mjs`): apps and other packages cannot import `db/schema` or `drizzle-orm`, and `apps/web`, `core` and `shared` cannot import the db package at all.

## Tenant isolation rules

- **Reads** take `installationIds` (the caller's accessible installations, from `system.listAccessibleInstallationIds`) as the second argument. An empty or malformed list matches nothing.
- **Writes** take the single `installationId` they act on as the second argument and never touch another installation's rows. A row that is missing and a row that belongs to someone else are indistinguishable (`NotFoundError` or an empty result).
- Child tables carry `installation_id` and use composite foreign keys, so the database refuses cross-installation links even for code that bypasses this layer.
- Provider key ciphertext is returned only by `system.getProviderCredentialForWorker`; tenant functions return `CredentialInfo` (provider, `last4`, metadata).
- Run status changes only through `transitionRun` (lifecycle in `src/lifecycle.ts`, scope §5.1). It is one conditional `UPDATE`, so racing writers cannot both win.

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

Migrations are forward-only. `MIGRATIONS_FOLDER` resolves relative to the source file, so run `db:migrate` from the workspace (as the deploy step) instead of from an esbuild bundle.

## Tests

Tests use a **real PostgreSQL** (no mocks): each test file creates its own empty database from `DATABASE_URL`, migrates it and drops it afterwards. Start the database first with `npm run db:up`.
