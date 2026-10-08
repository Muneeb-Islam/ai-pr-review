# Technical Design

AI PR Review Platform. Source of truth for architecture, interfaces and behaviour. Read this with `scope.md` and `decision-log.md` at the start of every implementation session.

## 1. Architecture

```
                    ┌──────────────────────────────────────────────┐
 GitHub  ──webhook─►│ api (Fastify)                                │
  (App)             │  /webhooks/github  → verify, record, enqueue │
   ▲                │  /auth/*  /api/*   → REST, SSE               │
   │                └───────┬───────────────────────┬──────────────┘
   │ checks, reviews,       │ BullMQ (Redis)        │ SQL
   │ comments               ▼                       ▼
   │                ┌───────────────┐        ┌──────────────┐
   └────────────────│ worker        │───────►│ PostgreSQL   │
                    │  run lifecycle│        └──────────────┘
                    │  review engine│  ──► LLM providers (DeepSeek / Anthropic / OpenAI)
                    └───────────────┘
 Browser ──► web (React + Vite SPA) ──► api  (cookie session, SSE for live runs)
```

- **api** receives webhooks and serves the dashboard API. It never runs reviews.
- **worker** consumes jobs, runs the review engine, writes results to PostgreSQL and publishes to GitHub.
- **web** is a static SPA; it only talks to the api.
- **packages/core** is the review engine (no HTTP, no DB), used by the worker.
- No process checks out or executes repository code. All repository data is read through the GitHub API with an installation token.

## 2. Repository layout (npm workspaces)

```
apps/
  api/        Fastify server: webhooks, auth, REST, SSE
  worker/     BullMQ worker: run lifecycle, engine, publisher calls
  web/        React + Vite dashboard
packages/
  shared/     types, zod schemas (config, API contracts), logger, constants
  core/       review engine: context, policy, providers, agents, validation, publisher
  db/         Drizzle schema, migrations, tenant-scoped data access
docs/  examples/  scripts/  docker/
```

Migration of the existing Action code (commit `b77c898`):

| Existing                                                                                                      | Goes to                     | Notes                                                                     |
| ------------------------------------------------------------------------------------------------------------- | --------------------------- | ------------------------------------------------------------------------- |
| `src/types/*`                                                                                                 | `packages/shared`           | Unchanged. Add run/status types.                                          |
| `src/config/*`, `schemas/*`                                                                                   | `packages/shared`           | `fork_prs` becomes `skip \| review`. Split sensitive keys (§6).           |
| `src/events/guards.ts`                                                                                        | `packages/core` (`routing`) | Pure `decide()` stays; the fork rule now follows `fork_prs`.              |
| `src/events/router.ts`, `src/main.ts`                                                                         | rewritten in `apps/api`     | Action payloads → webhook handlers.                                       |
| `src/github/client.ts`                                                                                        | `packages/core` (`github`)  | Replace `@actions/github` with Octokit + App auth; keep retry/throttling. |
| `src/util/logger.ts`                                                                                          | `packages/shared`           | Keep redaction rules.                                                     |
| `test/*`                                                                                                      | alongside moved code        | Keep and adapt.                                                           |
| `action.yml`, `dist/`, `scripts/build.mjs`, Action workflow, `examples/workflow.yml`, `scripts/local-run.mjs` | removed                     | Replaced by webhook replay script.                                        |

## 3. Technology

| Area               | Choice                                                                                                 |
| ------------------ | ------------------------------------------------------------------------------------------------------ |
| Language / runtime | TypeScript (strict), Node.js (current LTS; repo already requires ≥ 24)                                 |
| API                | Fastify, zod for validation, OpenAPI generated from schemas                                            |
| Database           | PostgreSQL, Drizzle ORM + drizzle-kit migrations                                                       |
| Queue              | Redis + BullMQ                                                                                         |
| GitHub             | `@octokit/app`, `@octokit/core` with retry and throttling plugins, webhook verification                |
| Auth               | GitHub App user-to-server OAuth, server-side sessions in PostgreSQL, HttpOnly cookie                   |
| Frontend           | React, Vite, React Router, TanStack Query, Tailwind CSS, accessible component primitives, Recharts     |
| Realtime           | Server-sent events (Redis pub/sub fan-out), polling fallback                                           |
| Testing            | Vitest; Testing Library for web; Playwright for dashboard smoke tests; Postgres/Redis via Docker in CI |
| Tooling            | ESLint, Prettier, npm workspaces, GitHub Actions CI (this repo only)                                   |

## 4. GitHub App

- **Permissions:** Metadata read; Contents read; Pull requests read & write; Checks read & write; Actions read (coverage artifacts); Issues read (GitHub requires it for the `issue_comment` event that carries `/ai-review`); organization Members read (Phase 4: distinguishes an organization owner from a member; without it organization-level admin rights are unavailable, repository admin rights are unaffected). Nothing else.
- **Events:** `pull_request`, `issue_comment`, `check_run` (rerequested), `installation`, `installation_repositories`. Optional later: `workflow_run`.
- **Webhook:** `POST /webhooks/github`. Verify `X-Hub-Signature-256` over the **raw body**; reject on mismatch; store `X-GitHub-Delivery`; respond `202` quickly; do all work asynchronously.
- **Auth:** App JWT → installation access token (cached until shortly before expiry). Tokens are never persisted or logged.
- **User login:** OAuth via the same App (authorization code flow with `state` and PKCE S256). The user token is used once, at sign-in, to list the user's installations, repositories and organization role; it is never stored. Later re-checks use the App's installation token.

## 5. Data model (PostgreSQL)

Every tenant table has `installation_id`; data access goes through helpers that require it (§9).

| Table                   | Key columns                                                                                                                                                                                                                                                                 |
| ----------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `users`                 | id, github_user_id, login, avatar_url, created_at                                                                                                                                                                                                                           |
| `sessions`              | id, user_id, expires_at (absolute end), last_seen_at (idle clock), csrf_secret, created_at                                                                                                                                                                                  |
| `installations`         | id, github_installation_id, account_login, account_type, status (`active`/`suspended`/`deleted`), created_at                                                                                                                                                                |
| `user_installations`    | user_id, installation_id, role (`admin`/`viewer`), refreshed_at (cache of GitHub access)                                                                                                                                                                                    |
| `user_repositories`     | user_id, installation_id, repo_id, role (`admin`/`viewer`), refreshed_at (cache of the repositories the user can reach)                                                                                                                                                     |
| `installation_settings` | installation_id, config (jsonb, the installation-wide defaults layer), updated_by, updated_at                                                                                                                                                                               |
| `repositories`          | id, installation_id, github_repo_id, full_name, default_branch, is_private, enabled, active                                                                                                                                                                                 |
| `repo_settings`         | repo_id, config (jsonb, validated), updated_by, updated_at                                                                                                                                                                                                                  |
| `provider_credentials`  | id, installation_id, repo_id (nullable), provider, ciphertext, key_version, last4, created_by, created_at                                                                                                                                                                   |
| `webhook_deliveries`    | delivery_id (unique), event, installation_id, received_at, processed_at, outcome                                                                                                                                                                                            |
| `review_runs`           | id, repo_id, pr_number, head_sha, base_sha, base_ref, trigger, triggered_by, status, status_reason, check_run_id, summary_comment_id, queued_at, started_at, finished_at, parent_run_id, warnings (jsonb), usage (jsonb), skipped_files (jsonb), coverage (jsonb, Phase 11) |
| `agent_runs`            | id, run_id, agent, status, started_at, duration_ms, input_tokens, output_tokens, retries, warnings                                                                                                                                                                          |
| `findings`              | id, run_id, repo_id, agent, category, severity, confidence, title, file_path, start_line, end_line, evidence (short), impact, recommendation, suggested_test, fingerprint, posted (bool), suppressed_reason                                                                 |
| `posted_comments`       | id, run_id, kind (`review_comment`/`summary`/`check`), github_id, fingerprint, head_sha                                                                                                                                                                                     |
| `finding_feedback`      | finding_id, user_id, verdict (`useful`/`false_positive`/`known`), note, created_at                                                                                                                                                                                          |
| `audit_log`             | id, installation_id, user_id, action, target, metadata, at                                                                                                                                                                                                                  |

Implementation notes (Phase 2, `packages/db`): the child tables `repo_settings`, `review_runs`, `agent_runs`, `findings`, `posted_comments` and `finding_feedback` carry `installation_id` and reference their parent through a composite foreign key `(installation_id, parent_id)`, so the database rejects a row whose installation differs from its parent's. `webhook_deliveries.delivery_id` is the primary key. Statuses, agents, severities, categories, verdicts and the like are Postgres enums built from the value lists in `packages/shared`. `findings.evidence` is `varchar(500)`; the data layer truncates longer text. Unscoped queries exist only in `@ai-pr-review/db/system`.

Implementation notes (Phase 3): `createRunSupersedingOlder` creates a `queued` run and supersedes the PR's other active runs in one transaction guarded by a per-PR advisory lock, returning the existing run when an identical active run (same head SHA and trigger) exists. A `webhook_deliveries` row with outcome `error` can be reclaimed by a redelivery of the same ID; any other row makes the redelivery a duplicate. See `docs/github-app-setup.md`.

Implementation notes (Phase 4): `user_repositories` narrows `user_installations` to the repositories GitHub says the user can reach (an installation can cover repositories a member cannot see); it carries `installation_id` and a composite foreign key like the other child tables. Both tables are caches with a short TTL: they are replaced at sign-in and re-verified on demand (§9). `installation_settings` holds the layer between built-in defaults and `repo_settings`. Provider key ciphertext layout and key rotation: §9.

Indexes: `review_runs(repo_id, queued_at desc)`, `review_runs(status)`, `review_runs(repo_id, pr_number, head_sha)`, `findings(run_id)`, `findings(repo_id, severity)`, `webhook_deliveries(delivery_id)`. Retention deletes finished runs older than `RETENTION_DAYS` with their children (active runs are left to the sweeper).

## 6. Configuration

Effective config for a run = defaults < installation defaults (`installation_settings.config`) < dashboard settings (`repo_settings.config`) < `.github/ai-pr-review.yml` read from the **base branch** at the base SHA, restricted to non-sensitive keys.

| Key group                                                                                  | Source                 | Notes                                                                                                                                                          |
| ------------------------------------------------------------------------------------------ | ---------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `provider`, `model`, `base_url`, `limits`, credentials                                     | **dashboard only**     | A repo file cannot choose where code is sent or raise cost limits. `base_url` must be HTTPS and must not resolve to private, loopback or link-local addresses. |
| `review.*`, `agents.*`, `coverage.*`, `ignore`, `secret_paths`, `instructions`, `fork_prs` | dashboard or repo file | Repo file wins when both set a key.                                                                                                                            |

```yaml
provider: deepseek # anthropic | openai | deepseek   (dashboard only)
model: <model-id> # dashboard only
base_url: # optional OpenAI-compatible endpoint, dashboard only
review:
  mode: comment_only # comment_only | warn | fail_on_threshold
  target_branches: [main, master]
  draft_behavior: summary_only
  minimum_severity: medium
  minimum_confidence: 0.80
  max_changed_files: 40
  max_patch_characters: 120000
  max_inline_comments: 20
agents: { code_review: true, test_coverage: true, security: true, final_review: false }
coverage:
  artifact_name: coverage # Actions artifact name
  lcov_path: lcov.info # path inside the artifact
fork_prs: skip # skip | review
ignore: ["dist/**", "coverage/**", "**/*.lock"]
secret_paths: ["**/.env*"]
instructions: ""
limits: { concurrency: 3, max_requests: 20, max_total_tokens: 400000, request_timeout_ms: 120000 }
```

Server environment (not per-repo): `DATABASE_URL`, `REDIS_URL`, `GITHUB_APP_ID`, `GITHUB_APP_PRIVATE_KEY`, `GITHUB_WEBHOOK_SECRET`, `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET`, `SESSION_SECRET` (≥ 32 characters), `ENCRYPTION_KEY` (32 bytes, base64) with `ENCRYPTION_KEY_VERSION` and, while rotating, `ENCRYPTION_KEY_PREVIOUS[_VERSION]`, `PUBLIC_URL` (dashboard), `API_PUBLIC_URL` (OAuth callback host), `RETENTION_DAYS`, quota defaults, and the tunables `SESSION_IDLE_TIMEOUT_MINUTES`, `SESSION_ABSOLUTE_TIMEOUT_HOURS`, `ACCESS_CACHE_TTL_SECONDS`, `RATE_LIMIT_PER_IP_PER_MINUTE`, `RATE_LIMIT_PER_USER_PER_MINUTE`, `TRUST_PROXY`. Validated at startup; missing or invalid values fail fast with the variable name only.

## 7. Run lifecycle

```
webhook ──► api: verify → dedupe delivery → guards (branch, draft, fork, enabled, quota)
        ├─ guard says skip ─► create run `skipped` (+reason) ─► done
        └─ eligible ─► supersede older queued/running runs for the PR
                      create run `queued` ─► create Check Run (queued) ─► enqueue job(runId)
worker: claim → mark `running`, Check Run in_progress
        → collect context → run agents (parallel, capped) → validate/dedupe → policy
        → persist findings & agent runs → publish review + summary + Check Run conclusion
        → mark `completed` | `partial` | `failed`
        (abort signal is checked between stages; superseded/cancelled runs stop early and publish nothing)
```

- Job payload is only `{ runId }`; the worker loads everything else from the database. Handlers are idempotent so a retried job cannot double-post (fingerprints + `posted_comments`).
- Infrastructure failures (Redis, database, GitHub 5xx) retry with backoff. Review failures (provider timeout, bad output) become `partial` or `failed` with warnings; they are not retried indefinitely.
- Fairness: per-installation concurrency cap plus global worker concurrency; a stuck-job sweeper requeues runs whose worker heartbeat expired.
- Every state change writes the row, then publishes `run.updated` on Redis for SSE.

## 8. API

REST under `/api`, JSON, zod-validated, session cookie + CSRF header on mutations. Cursor pagination on lists. Errors: `{ error: { code, message, request_id, details? } }`. Cross-tenant access returns 404.

The endpoint table lives in `packages/shared/src/api/contract.ts`: path, method, auth, the resource behind `:id` and the role it needs, and the zod schemas of parameters, query, body and response. The api registers every route from that table (`apps/api/src/http/platform.ts`), the OpenAPI document (`packages/shared/schemas/openapi.json`) is generated from it, and the web app's typed client (`createApiClient`) is typed by it.

| Method & path                                                                                     | Purpose                                                                                                                                                                                                      |
| ------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `GET /auth/github/login` · `GET /auth/github/callback` · `POST /auth/logout`                      | Sign in / out                                                                                                                                                                                                |
| `GET /api/me`                                                                                     | Current user, installations, `install_url`                                                                                                                                                                   |
| `GET /api/repos` · `GET /api/repos/:id`                                                           | Repos the user can see, with last-run summary                                                                                                                                                                |
| `GET/PATCH /api/repos/:id/settings`                                                               | Read / update settings and enabled state (admin to write); returns stored, inherited and effective configuration                                                                                             |
| `GET/PATCH /api/installations/:id/settings`                                                       | Installation-wide defaults (admin to write) and read-only quotas                                                                                                                                             |
| `GET/PUT/DELETE /api/repos/:id/credentials` · `GET/PUT/DELETE /api/installations/:id/credentials` | Provider keys, admin only. PUT is write-only; GET lists provider, last four characters and timestamp; DELETE takes `?provider=`                                                                              |
| `POST /api/repos/:id/credentials/test` · `POST /api/installations/:id/credentials/test`           | One minimal provider call with the key in the request body (not stored); sanitised result                                                                                                                    |
| `GET /api/runs`                                                                                   | Filters: repo, status (one or a comma-separated list), branch, author, severity, from, to, cursor, limit. Only runs of repositories the user can reach                                                       |
| `GET /api/runs/:id`                                                                               | Run with agent runs, findings, skipped files, suppressed counts, warnings, usage, measured coverage (or why there is none), PR and Check Run links. Access is access to the run's repository (404 otherwise) |
| `POST /api/runs/:id/rerun` · `POST /api/runs/:id/cancel`                                          | Admin actions, audited                                                                                                                                                                                       |
| `GET /api/findings` · `GET /api/findings/:id`                                                     | Findings explorer                                                                                                                                                                                            |
| `POST /api/findings/:id/feedback`                                                                 | useful / false_positive / known                                                                                                                                                                              |
| `GET /api/analytics/summary` · `GET /api/analytics/timeseries`                                    | Metrics, filtered by repo and range                                                                                                                                                                          |
| `GET /api/events`                                                                                 | SSE stream of `run.updated` (ids and status only) for the user's repos                                                                                                                                       |
| `POST /webhooks/github`                                                                           | GitHub webhooks                                                                                                                                                                                              |
| `GET /healthz` · `GET /readyz`                                                                    | Liveness / readiness                                                                                                                                                                                         |
| `GET /metrics`                                                                                    | Operator metrics in the Prometheus format; bearer token `METRICS_TOKEN`; absent without one, not proxied by the web server (operations.md §7)                                                                |

## 9. Security model

- **Tenant isolation:** every data-access function takes the caller's accessible installation IDs. There is no unscoped query for tenant tables outside the worker. Authorisation tests cover every endpoint (AC-17), and PostgreSQL row-level security enforces the same boundary underneath the application code (Phase 15 notes below).
- **Authentication:** GitHub OAuth, server-side session, `HttpOnly; Secure; SameSite=Lax` cookie, CSRF token on mutations, short idle timeout, logout invalidates the session.
- **Authorisation:** viewer = any access to the repo through the installation; admin = GitHub admin permission on the repo or org owner. Access is re-checked against GitHub with a short cache (`user_installations.refreshed_at`).
- **Secrets:** provider keys use envelope encryption (AES-256-GCM, per-record data key wrapped by `ENCRYPTION_KEY` with a `key_version` for rotation). Keys are decrypted in the worker only, passed to the provider adapter in memory, never logged, never serialised into job payloads or API responses.
- **Webhooks:** raw-body signature check, constant-time compare, delivery-ID idempotency, payload size limit.
- **Outbound:** provider calls only to allow-listed hosts or a validated `base_url`; no tool access for agents.
- **Prompt injection:** repository text is wrapped in per-run randomised delimiters and treated as data; output is schema-validated; agents have no network, file or tool capability; only validated findings reach GitHub.
- **Repository config:** read from the base branch only; sensitive keys cannot come from the repo.
- **Browser:** strict CSP, no inline scripts, CORS restricted to the web origin, security headers via the api/static server.
- **Data minimisation:** no diffs or source persisted; evidence excerpts ≤ 500 characters; retention cleanup job.

Implementation notes (Phase 4, `apps/api`):

- **Sign-in flow.** `/auth/github/login` sets a signed, HttpOnly, 10-minute flow cookie (`state`, PKCE verifier, return path) scoped to `/auth/github` and redirects to GitHub with `state` and a PKCE S256 challenge. The callback verifies the cookie signature and expiry and compares `state` in constant time, exchanges the code, loads the user, refreshes the access cache, deletes the session that came with the request (rotation) and issues a new one. Every failure redirects to `PUBLIC_URL/login?error=<code>` and creates no session. `return_to` must be a single-slash path.
- **Sessions.** The cookie is `<session id>.<HMAC>`; the row in `sessions` holds the user, an absolute end and a last-seen time (idle timeout; refreshed at most once a minute). Expired or idle sessions are deleted when seen and swept hourly. Logout deletes the row.
- **CSRF.** The token is derived, not stored: HMAC(`SESSION_SECRET`, session id + per-session secret). `GET /api/me` returns it; every mutation must send it as `X-CSRF-Token`. A mutation whose `Origin` header is not the dashboard or api origin is refused first.
- **Order of checks** for each contract endpoint: IP rate limit → origin (mutations) → session (401) → CSRF (403) → user rate limit → access to the resource behind `:id` (404 for none or another tenant, 403 for too little role) → input validation (400) → handler → response parsed through the contract schema, which strips anything undeclared.
- **Roles.** Installation role: admin = owner of a personal account or organization owner (organization membership role), viewer otherwise. Repository role: admin = GitHub admin permission on the repository (organization owners have it), viewer otherwise. The cache is filled at sign-in with the user's token and re-verified after `ACCESS_CACHE_TTL_SECONDS` with the installation token (`GET /repos/{o}/{r}/collaborators/{login}/permission`, `GET /orgs/{org}/memberships/{login}`). Repository access is authoritative and checked on use; an installation row alone never grants repository data. Failures to verify fail closed (503 for the request, nothing listed, never stale admin rights). When the App lacks the organization Members permission the role is `unknown` and treated as viewer.
- **Provider keys.** `encryptSecret` (packages/core): a random 32-byte data key per record encrypts the secret with AES-256-GCM; the data key is wrapped with `ENCRYPTION_KEY` (AES-256-GCM, the version in `key_version`); the stored blob is `format ‖ wrap nonce ‖ wrapped key ‖ data nonce ‖ sealed secret`. The installation, repository and provider of the record are authenticated as additional data, so a blob copied to another row does not decrypt. Only `apps/worker/src/credentials.ts` decrypts. Rotation (`npm run credentials:rotate`) re-wraps data keys without decrypting secrets and updates rows conditionally on the version it read.
- **`base_url`.** `validateBaseUrl` (packages/core): https only, no embedded credentials, no `localhost`, `.local`, `.internal` names, no loopback, private, link-local (including 169.254.169.254), CGNAT, multicast or reserved addresses (IPv4, IPv6, IPv4-mapped, NAT64, 6to4), checked on the parsed URL (so decimal, hex and octal forms are caught) and again on every address the name resolves to. `createSafeLookup` repeats the check at connection time (DNS rebinding) for the "test connection" call and, from Phase 6, the provider adapters.
- **Errors and logs.** One envelope with a request id (also `X-Request-Id`). Framework errors use fixed texts, never the framework's message (it can quote the body, and a body can be a key). Unexpected errors log the error name only. Request lines carry the route pattern, never the URL.
- **Rate limits.** Fixed one-minute windows in Redis (in-memory fallback if Redis is away): per IP on `/api` and `/auth`, per signed-in user, and a stricter per-user limit on "test connection".

## 10. Core engine interfaces (`packages/core`)

```ts
export type Severity = "critical" | "high" | "medium" | "low" | "info";
export type Category = "bug" | "security" | "test_gap" | "performance" | "maintainability";
export type AgentId = "code_review" | "test_coverage" | "security" | "final_review";
export type RunStatus =
  | "queued"
  | "running"
  | "completed"
  | "partial"
  | "failed"
  | "skipped"
  | "superseded"
  | "cancelled";

export interface Finding {
  // unchanged from PRD §12
  id: string;
  agent: AgentId;
  category: Category;
  severity: Severity;
  confidence: number;
  title: string;
  filePath?: string;
  startLine?: number;
  endLine?: number;
  evidence: string;
  impact: string;
  recommendation: string;
  suggestedTest?: string;
  sourceCommitSha: string;
}

export interface ChangedFile {
  path: string;
  previousPath?: string;
  status: "added" | "modified" | "removed" | "renamed";
  additions: number;
  deletions: number;
  patch?: string;
  addedLines: Array<{ start: number; end: number }>;
}

export interface ReviewContext {
  pr: {
    number: number;
    title: string;
    body: string;
    author: string;
    baseRef: string;
    baseSha: string;
    headSha: string;
    isDraft: boolean;
    isFork: boolean;
  };
  files: ChangedFile[]; // filtered; safe to send to a model
  skippedFiles: Array<{ path: string; reason: string }>;
  testFiles: Record<string, string[]>;
  prior: {
    fingerprints: string[];
    summaryCommentId?: number;
    comments: Array<{ id: number; fingerprint: string; headSha: string; path?: string }>;
  };
  limits: { status: "ok" | "limited" | "skipped"; reason?: string };
  config: ResolvedConfig; // effective: defaults < dashboard < repo file at the base SHA
  warnings: string[]; // config-file problems, truncated lists, ...
  stats: {
    changedFiles: number;
    includedFiles: number;
    skippedFiles: number;
    patchCharacters: number;
    redactions: number;
  };
  isLineInDiff(path: string, line: number): boolean; // added lines of included files only
  isRangeInDiff(path: string, startLine: number, endLine: number): boolean; // both ends in one hunk
  diffPosition(path: string, line: number): number | undefined;
}

export interface ProviderRequest {
  system: string;
  user: string;
  jsonSchema: object;
  maxOutputTokens: number;
  timeoutMs: number;
  signal?: AbortSignal;
}
export interface Provider {
  readonly name: "anthropic" | "openai" | "deepseek";
  complete(req: ProviderRequest): Promise<{
    json: unknown;
    usage: { inputTokens: number; outputTokens: number };
    model: string;
    retries: number;
  }>;
}
// Errors: ProviderTimeout | ProviderRateLimit | ProviderUnavailable | ProviderAuthError | ProviderInvalidResponse

export interface AgentTask {
  agent: AgentId;
  context: ReviewContext;
  files: ChangedFile[];
  config: ResolvedConfig;
  repoInstructions?: string;
  signal?: AbortSignal;
}
export interface AgentResult {
  agent: AgentId;
  status: "ok" | "failed" | "timeout" | "invalid_output";
  findings: Finding[];
  observations: string[];
  coverage?: {
    status: "measured" | "not_available" | "skipped";
    changedLineCoverage?: number;
    observations: string[];
  };
  durationMs: number;
  usage: { inputTokens: number; outputTokens: number };
  retries: number;
  warnings: string[];
}
export interface Agent {
  readonly id: AgentId;
  run(task: AgentTask, deps: { provider: Provider; logger: Logger }): Promise<AgentResult>;
}

export interface FindingValidator {
  validate(
    findings: Finding[],
    ctx: ReviewContext,
    cfg: ResolvedConfig,
  ): { accepted: Finding[]; suppressed: Array<{ finding: Finding; reason: SuppressReason }> };
}
export type SuppressReason =
  | "below_threshold"
  | "invalid_line"
  | "no_evidence"
  | "duplicate"
  | "style_only"
  | "rejected_by_final_review";
```

The engine takes an Octokit instance, a decrypted provider key and an `AbortSignal` as parameters. It does not read the environment or the database.

Implementation notes (Phase 5, `packages/core/src/context`):

- **Entry point.** `collectContext({ octokit, repo, prNumber, config, signal?, logger?, appLogin? })`. `octokit` is anything with `request(route, params)` (the real `GitHubClient` fits; tests pass a fake). `config` is the dashboard layer (installation defaults merged with the repository's settings), not yet validated. Every call carries the signal. Responses are parsed with loose zod schemas; a malformed response throws without echoing the payload.
- **Order of work.** PR → config file at the **base SHA** (`contents` API, `ref=baseSha`; the head is never read for config) → changed files (paginated, 100 per page, GitHub caps at 3000) → exclusions → redaction → size policy → prior App comments → test discovery. A `skipped` size result stops before the last two.
- **Config file.** Sensitive keys are dropped with a warning; a file that is invalid YAML, fails the schema, is over 64 KB or is not a file is ignored with a warning and the dashboard layer is used. 404 means no file. Any other GitHub error is thrown (the job retries) rather than reviewing with different settings.
- **Exclusions** (`classify.ts`, `patterns.ts`): checked by path in this order, so the reason shown is the most serious: secret patterns, binary extensions, lockfiles, vendored directories, build output, generated names, then the config `ignore`. Content checks follow: a "generated" banner in the first lines of a new file, or minified code (lines over 2000 characters in JS/CSS). Files with no `patch` are skipped with a reason (diff too large vs. no textual changes). Patterns are gitignore-like: `dir/` is a directory, a pattern without `/` matches at any depth, dotfiles match.
- **Redaction** (`redact.ts`): known token formats (GitHub, AWS access key, Slack, Stripe, Google, npm, `sk-` keys, JWT), bearer tokens, URL passwords and PEM private-key blocks become `[REDACTED:<kind>]`. It works line by line and keeps the diff prefix, so line numbers and positions are unchanged. The PR title and description are redacted too.
- **Diff** (`diff.ts`): `parsePatch` yields hunks with old and new line numbers and GitHub diff positions (the line after the first `@@` is 1; later hunk headers count). `\ No newline at end of file` is kept as a `meta` line. The index behind `isLineInDiff` is built from the files left after filtering and size limits.
- **Size policy** (`size.ts`): files are taken in priority order (source, tests, config, docs, then path) until `max_changed_files` or `max_patch_characters` is reached; later, smaller files can still fit. `limited` lists what was left out; `skipped` applies when nothing fits or the PR is more than five times over a limit. `estimateTokens` (about 3.5 characters per token, rounded up) is for Phase 6 budgeting.
- **Prior comments**: markers are `<!-- ai-pr-review:fp=<16 hex>;sha=<sha> -->` and `<!-- ai-pr-review:summary -->` (`markers.ts`, shared with the publisher in Phase 9). Only comments by bot accounts count (or by `appLogin` when given).
- **Nearby code** (`nearby.ts`): `createNearbyCodeReader` is called by the orchestrator where the diff's own context is not enough. It reads only files in the review at the head SHA, prefers the enclosing function (an indentation heuristic for JS/TS), falls back to a window of lines, and stops at per-snippet and per-run budgets.
- **Test discovery** (`test-discovery.ts`): one git-trees call at the head SHA, only when the Test Coverage agent is enabled; JS/TS test files by name and directory; each changed source file maps to tests next to it, in `__tests__`, in a mirrored `test/` tree, or (unless the name is generic) a same-name test in the same package. Unmatched files map to `[]`.
- **No ambient data.** The context code never reads the environment or the filesystem; a test scans the module for `process.env`, `node:fs` and `node:child_process`.

Implementation notes (Phase 6, `packages/core/src/providers`):

- **Entry point.** `createProvider({ name, model, apiKey, baseUrl?, temperature?, logger?, governor? })`. The adapters are `DeepSeekProvider` and `OpenAIProvider` (both on `OpenAiCompatibleProvider`, chat completions) and `AnthropicProvider` (Messages API); each translates the neutral `ProviderRequest` itself and returns `{ json, usage, model, retries }`. `Provider` also exposes `model`. The package never reads the environment; the worker passes the decrypted key and registers it for log redaction (`createProvider` does that too).
- **Structured output.** DeepSeek: JSON mode, with the schema and a generated example in the system prompt (no schema enforcement; Phase 7 validates). OpenAI: `json_schema`, `strict` only when the schema meets OpenAI's rules (all properties required, no extra ones), otherwise sent unenforced; on a custom `baseUrl` it falls back to JSON mode and `max_tokens`; reasoning models (`o*`, `gpt-5*`) get no temperature. Anthropic: one forced tool whose input schema is the answer schema. Temperature defaults to 0; `temperature: null` leaves it out.
- **Failure mapping.** 401/403 `ProviderAuthError`; 429 `ProviderRateLimit` (with `retryAfterMs`); network, 408 and 5xx `ProviderUnavailable`; timeout `ProviderTimeout`; other 4xx, non-JSON, empty, refused or truncated (`finish_reason: length`) output `ProviderInvalidResponse`; abort `ProviderCancelled`; budget `ProviderBudgetExceeded`. Messages are fixed sentences, never the response body or the key; the error carries `status` and `retries`.
- **Run limits.** `RunGovernor` (one per run, `governor.wrap(provider)` or `createProvider({ governor })`) caps concurrent requests across all agents, refuses new requests past `max_requests` or `max_total_tokens`, and serves waiting requests in order; a waiting request is cancelled by its signal without reaching the network. `governor.snapshot()` gives requests and token usage for `review_runs.usage`.
- **Outbound.** A request goes only to the provider's own host (a constant) or a `baseUrl` that passes `validateBaseUrl` again on every call; the default transport applies `createSafeLookup` at connection time. Logs carry provider, model, host, sizes, status, retries and duration; a one-line notice at creation says which provider receives code.

Implementation notes (Phase 7, `packages/core/src/{agents,validation,prompts}`):

- **Entry point.** `runReview(context, config, provider, signal?, options?)` returns an `EngineResult`: `status` (`completed`, `partial`, `failed`, `skipped`), `findings` (validated, deduplicated, most severe first), `suppressed` with `suppressedCounts` per reason, `agentRuns` (the `AgentRun` of `packages/shared`: status, duration, tokens, retries, warnings), `observations`, `warnings` (context warnings plus every agent's), `usage` and the run governor's snapshot. It touches no database and no GitHub. A signal that fires makes it throw `ReviewAborted`; a cancelled or superseded run has nothing to publish. `options` carries the logger, an optional `RunGovernor` (to read its snapshot afterwards), the agent registry, a per-agent deadline and test hooks.
- **Orchestration.** Enabled agents (`config.agents`) that are registered and have files to look at run in parallel through one `RunGovernor`, so the concurrency cap and the request and token budgets are shared (FR-16). Each agent has its own `AbortSignal` (parent cancellation or its deadline, default five request timeouts) and a failure never reaches the others: a throw becomes `failed`, a missed deadline `timeout`, both with a fixed warning (AC-8). Agents that are enabled but not built yet (Final Review, until Phase 13) are ignored without a warning. `skipped` is returned, with no model call, when the size policy skipped the PR, no file is left, or no agent is enabled. `failed` needs every agent to fail and nothing to have been found; otherwise a failing agent, or a `limited` size result, makes the run `partial`.
- **Agent contract.** `AgentTask`, `AgentResult` and `Agent` follow the types above. `Agent` also has a `label` for warnings and an optional `selectFiles` (the Code Review agent skips deleted files; their paths are still listed in the prompt). `AgentResult.status` uses the persisted `AgentRunStatus`. `createLlmAgent` is the shared base for agents that ask a model for findings: prompt, chunking, request, validation, repair retry, normalisation.
- **Output schema.** The model answers `{ findings: [...], observations: [...] }` in snake_case with nullable optional fields, so one hand-written JSON Schema satisfies OpenAI strict mode, Anthropic tool input and DeepSeek JSON mode. Parsing is more forgiving than the schema sent: unknown keys are dropped and nullable fields may be missing. The Code Review agent may use `bug`, `performance` and `maintainability`; security and test gaps belong to the other agents.
- **Repair retry (FR-12 to FR-14).** A response is validated as a whole. If it fails (not an object, a bad enum, a confidence outside 0-1, a missing field), or the provider reports that the model's text was not JSON or was cut off, the agent makes one more request: the original message, the problems (zod's path and message, never the received value) and the rejected answer inside the delimiters. A second failure discards the answer: status `invalid_output` and the warning "a response did not match the expected format and was discarded". The repair counts as a retry. A rejected request (HTTP 4xx) is not repaired. Warnings and logs contain fixed sentences only, never model output, code or PR text.
- **Prompts (section 11).** `prompts/codeReview.v1.ts` is the versioned prompt (`id`, `version`, role, task, rubric, output); `composeSystemPrompt` adds the untrusted-content rule. The user message is our intro plus one delimited block holding everything from the repository: PR title and description, repository instructions, the file list, deleted files, the diff, and file paths. The id is 16 random hex characters per agent run, checked to be absent from the content. The repair request wraps the rejected answer in the same delimiters. The agent logs `prompt=<id>.v<version>` with every run.
- **Diff rendering and chunking.** Lines are shown as `<new-file line> <+|space|-> <code>` (deleted lines have no number), so the model reads line numbers instead of counting from hunk headers, and any window of lines is as valid as a whole hunk. A request carries at most `min(24 000, max_total_tokens / 3)` estimated tokens including the prompt: whole files while they fit, then hunks, then line windows; a file that continues in the next request repeats its header. Every request lists all files of the PR for cross-file context. If some parts fail, the agent's status is its worst part's, the good parts' findings are kept and a warning says how many parts were not reviewed.
- **Finding validator (FR-19).** `validateFindings` gives each finding the first reason that applies: `no_evidence` (evidence or impact missing, or an impact that says "none"), `invalid_line` (file not reviewed; start line not an added line of it; an end line without a start; a line without a file), `style_only`, `below_threshold` (`minimum_severity`, `minimum_confidence`), then `duplicate`. An end line that is not in the start line's hunk is narrowed to the start line rather than dropping the finding. A general finding (no file, no line) and a file-level one (no line) are kept. Style-only means category `maintainability` and a title or impact about formatting, quotes, semicolons, naming conventions, import order, linters or missing comments; a real defect is never style-only. Duplicates are judged after the other checks, within the run and against the fingerprints of comments the App already posted on the PR (`prior.fingerprints`), so a dropped finding cannot hide a good one. Fingerprints are `Finding.id` (section 12). Thresholds are applied here, so a finding below them is counted and not summarised.

Implementation notes (Phase 9, `packages/core/src/publisher` and `apps/worker/src/publisher.ts`):

- **Split.** `packages/core` renders and talks to GitHub (`publishReview`, `renderSummary`, `renderInlineComment`, `renderCheckOutput`, `startCheckRun`, `completeCheckRun`); it takes an Octokit-shaped client and touches no database. The worker's `GitHubPublisher` adds the database: it loads the repository, passes the fingerprints already posted for the head SHA, and afterwards records comment ids, marks findings and closes the Check Run. The `Publisher` interface has three methods: `start` (Check Run to `in_progress`; creates the Check Run if the api could not), `publish` (review, summary, Check Run conclusion) and `conclude` (close the Check Run of a run that ended without a review).
- **Order inside `publish`.** Re-read the PR head; plan the inline comments; one Pull Request Review; the summary; the database records; the Check Run last, so its title and summary describe what really happened. `stillCurrent` is checked before every write. If the head is no longer the reviewed commit nothing is posted and the run becomes `superseded` (§12).
- **Inline review (FR-17, FR-18, FR-33).** All qualifying findings go in one review with event `COMMENT` (never approve or request changes), `commit_id` set to the reviewed head, and the line API (`path`, `line`, `side: RIGHT`, plus `start_line` when both ends of the range are in one hunk). A finding is inline when it has a file and start line, is not a test suggestion below high confidence (Phase 11), is not on a draft PR (unless `draft_behavior: full`), meets `minimum_severity` and `minimum_confidence`, has not been posted for this head SHA (database and the markers GitHub holds), and fits in `max_inline_comments` (most severe first; the rest stay in the summary with a note). Its path and line are checked against the diff the context was built from: GitHub's diff of one commit cannot change, and the head re-read proves the commit is still current. A finding that fails the check is dropped, its row becomes `suppressed_reason = invalid_line` and it is not summarised, exactly as the validator treats it.
- **GitHub refusals (design §13).** One bad position makes GitHub reject the whole review with a 422; the publisher then posts the comments one by one so the good ones land, and lists the rejected ones in the summary. A 403 (missing permission) or an outage is a fixed-sentence warning on the run and in the summary or Check Run, the publisher continues with what it can, and the Check Run is `neutral`. The model is never called again because publishing failed. Warnings are persisted on `review_runs.warnings`.
- **Summary (FR-20, FR-21, FR-31, FR-32).** The hidden marker comes first. It shows the status and commit, counts by severity, findings grouped by severity (critical and high open, long groups and low/info folded in `<details>`), the source agent of each finding and whether it is an inline comment, suggested tests (labelled as suggestions), a Coverage block, a Security block (Phase 12) and a Checks table, notes, skipped files with reasons, warnings, what was left out and why, and a link to the run (`PUBLIC_URL` + `/runs/<id>`). Plain markdown only, so it reads in dark mode and on a phone. It is created once and edited in place; before editing, the comment is read back and must carry the marker and be authored by the App (`isAppAuthor`), otherwise a new one is created and the other is left alone (FR-38). If it would exceed 60 000 characters the finding details are dropped, then the lists are cut.
- **Check Run (FR-30).** `queued` (api, Phase 3), `in_progress` (`start`), `completed` with a title and summary. `success` only for a completed review that was fully posted; `neutral` for partial, skipped, failed, superseded, cancelled, or when something could not be posted. Every path closes it: a failed run before the review, a skip by quota or a disabled repository, a size-policy skip (summary and check), a run superseded or cancelled while queued or running, and a run the sweeper gives up on. Enforcement-driven `failure` is Phase 13.
- **Outgoing text (FR-29).** `sanitizeText` runs on every model- or repository-derived string: secrets become `[REDACTED:<kind>]`; the marker prefix and HTML comments are broken so text cannot forge a marker; markdown images and link targets are removed; HTML tags and @mentions outside code are neutralised; code blocks are cut at 8 lines; evidence is quoted as at most three lines of 140 characters; every body gets a last redaction pass and a length cap.
- **Records.** `posted_comments` gets one `review_comment` row per inline comment (GitHub id from the review's comment list, matched by fingerprint) and one `summary` row; the writes are idempotent per run, kind and GitHub id. `review_runs.summary_comment_id` and `check_run_id` are set. `findings.posted` means "an inline comment is on the PR"; findings that appear only in the summary stay `posted = false`.

Implementation notes (Phase 11, `packages/core/src/{test-coverage,agents/testCoverage}`):

- **Two things that never mix (FR-25).** The _measurement_ is what CI's LCOV report says about the changed lines. It is computed by code, stored as `review_runs.coverage` (`CoverageSummary` in `packages/shared`: status, reason, `changedLineCoverage`, covered and total lines, per-file results, the artifact it came from) and shown in a "Coverage" block of the summary, the Check Run and the dashboard. It holds counts, paths and line ranges only. The _suggestions_ are findings of category `test_gap` from the model reading the diff next to the existing tests, always labelled "Suggested missing test" and "not measured coverage". A file that falls short of full coverage is a "Verified coverage deficiency" line in the coverage block, never a finding, so a measured number cannot be mistaken for a model's opinion and a model's guess cannot be shown as a number.
- **Finding the report (`artifact.ts`).** `GET /actions/runs?head_sha=` (the 10 newest runs), then each run's artifacts filtered by `coverage.artifact_name`; the newest one that has not expired wins, then its zip is downloaded and `coverage.lcov_path` is read from it (a unique file with the same name elsewhere in the archive is accepted, because `upload-artifact` stores paths relative to the common root). Every failure is a reason code, never an exception, and never fails the run: `actions_denied` (403/404; also a warning on the run, since the owner can fix it), `no_runs`, `ci_running` (a run for the commit is still active and nothing is uploaded yet), `no_artifact`, `artifact_expired`, `artifact_too_large`, `artifact_invalid`, `lcov_missing`, `lcov_invalid`, `lcov_empty`, `github_error`, `no_client`. Only an abort propagates. The reason is a fixed sentence in the summary ("Coverage could not be measured. ...") and the run stays `completed`.
- **Zip safety (`zip.ts`).** The archive is held in memory and never written anywhere (so there is no temp directory to clean up). Our own small reader supports stored and deflated entries and refuses encrypted, split and ZIP64 archives. Caps: archive 50 MB (checked from the artifact listing before downloading, and again on the bytes), 20 000 entries, 500 MB declared unpacked in total, 30 MB for the one entry we read, compression ratio 200. The entry is inflated with `maxOutputLength` set to its declared size plus one byte, its real size must equal the declared size and its CRC-32 must match; entries whose names could escape a directory (`..`, absolute, drive letters) are never read; two entries with one name are refused. Messages are fixed sentences that never quote the archive.
- **LCOV and paths (`lcov.ts`, `paths.ts`, `compute.ts`).** The parser reads `SF`, `DA`, `FN`/`FNDA` (also the lcov 2 form with an end line), `BRDA` and merges repeated records; a line it does not understand is counted and skipped; empty text and text without any `SF` record are errors. It was checked against real output of Jest (istanbul) and Vitest (v8), kept in `__fixtures__`. Report paths are normalised (backslashes, `./`, `file://`, drive letters, `..`) and one rule is chosen for the whole report: leave as is, strip the runner's workspace prefix, or add a monorepo package prefix, whichever explains most changed files. A tie between two different package prefixes (the same file name in two packages) matches nothing. A changed file the report does not hold is `not_in_report`: unknown, never 0%, and left out of the percentage. The percentage is covered over executable changed lines (those with a `DA` record) of matched files; a changed line without a `DA` record is not executable and counts for nothing. Per file it also lists uncovered ranges (at most 25), functions declared on changed lines that never ran, and changed branches taken.
- **Which files.** Coverage applies to changed JS/TS source files that are not tests and not deleted (`isJsTsSourceFile`). With none, coverage is `skipped` ("The pull request changes no source file that coverage applies to") and no model call is made. The agent _reads_ the pull request's JS/TS files, tests included, because a test added in the same pull request is the evidence that a new branch is covered.
- **What the model sees.** The numbered diff as for Code Review, plus two sections inside the untrusted block: "Related tests" (the files Phase 5's discovery mapped to each changed source file, and for up to six unchanged ones an outline of test and group names read at the head commit, secret-looking names never read) and "Measured coverage of the changed lines" (per file: lines that never ran, functions never called, or "not in the report", or why there is no report). The prompt (`prompts/testCoverage.v1.ts`) tells it to aim at uncovered lines and never to state a percentage.
- **Suggestions (FR-24).** Each carries a title starting "Missing test:", a file and an added line, evidence, impact, where to add it, and `suggested_test` in the shape `Target: ... Scenario: ... Setup: ... Assert: ...`. `refineSuggestions` drops one without a concrete test or aimed at a test file, caps severity at `medium` (a missing test must never be what blocks a merge under an enforcement mode), and keeps at most eight. In the summary they are listed under "Suggested tests"; one becomes an inline comment only when it has a file and an added line and its confidence is at least `TEST_GAP_INLINE_CONFIDENCE` (0.9), on top of the usual thresholds; the comment is headed "Suggested missing test" and its footer says it is not measured coverage.
- **Wiring.** `runReview` takes `options.github = { client, repo }` and gives it to the agents (`AgentDeps.github`); without it Test Coverage reports `no_client` and works from the diff. The worker passes the installation client it already holds. `createLlmAgent` gained two hooks for this: `prepare` (extra prompt sections, coverage, warnings, `skipModel`) and `refine`; `AgentResult.coverage` is the persisted `CoverageSummary`. The worker stores it with `saveRunResults` (bounded: 100 files, 25 ranges per file, 10 names, 400 characters of text) and the api returns it as `coverage` on `GET /api/runs/:id`.
- **Not built.** Re-evaluating coverage when a `workflow_run` completes (the phase file's stretch goal). When CI is still running the review says so (`ci_running`) and the owner can re-run it; the `workflow_run` event handler is the follow-up.

Implementation notes (Phase 12, `packages/core/src/{security,agents/security}`, `publisher/security.ts`):

- **What the agent reads.** `selectSecurityFiles`: changed files that were not deleted, with a patch, except documents (`md`, `txt`, ...) and test paths. `package.json` is included; lockfiles never get this far (Phase 5). A pull request that changes only documents or tests runs no Security agent and no model call; the Checks table says "Not run". The agent is `createLlmAgent` with category `security` only, the prompt `prompts/security.v1.ts`, a `prepare` hook (the dependency section) and a `refine` hook (below); it is registered in `DEFAULT_AGENTS`.
- **Prompt (FR-26, FR-29).** Covers injection (SQL, NoSQL, command, template, `eval`), authentication and authorisation, sensitive data and logging, unsafe deserialisation and prototype pollution, SSRF, path traversal, XSS and unsafe HTML, weak crypto and randomness, insecure CORS, cookie, TLS and CSP settings, and dependency risks, with Express, Fastify, Next.js, NestJS and React named. It asks for concrete evidence in the added lines (no generic advice, no guessing about middleware it cannot see), says that `[REDACTED:<kind>]` in the diff is itself a finding when a secret was committed, and forbids exploit code, attack strings, steps to exploit and credentials in its answer. Evidence is one line; `suggested_test` is always null; the advice field is called "Mitigation" wherever a security finding is shown.
- **Dependency review (`security/dependencies.ts`).** Done by code, not by the model. `analyzeManifestChanges` reads the patch of every `package.json` (new, changed and removed dependencies, scripts; the section a line is in is known when its opening line is in the hunk, otherwise the value decides: a version range or URL is a dependency, an install-script name is a script; a moved line is not a change). `dependencySignals` turns it into findings: an install script (`preinstall`, `install`, `postinstall`; high with a download or evaluation in the command, medium otherwise), a git or shorthand source without a full commit hash (medium), a tarball URL (medium), `http://` or `git://` (high), a new unscoped name one edit away from a popular package or equal to one once separators are removed (medium, confidence 0.8; a curated list of about 150 names). The prompt gets a "Dependency changes" section (what changed, and which findings the platform already made, so the model does not repeat them). The rule findings are added in `refine`, so they survive a model failure; a model finding on the same file and line is dropped as a repeat. The validator applies the thresholds to them like any finding.
- **Public-comment safety (FR-29, `security/sanitize.ts`).** `sanitizeSecurityText` extends the token-format redaction with (1) values assigned to a name that says secret (`password`, `token`, `api_key`, `client_secret`, ..., quoted or in `.env` style), (2) long random-looking quoted literals (entropy check), and (3) exploit payloads: SQL tautologies, `UNION SELECT`, stacked statements, three or more `../` (also URL-encoded) and `/etc/passwd`, `<script>`, event handlers and `javascript:`, shell chaining and command substitution, NoSQL operators, cloud metadata addresses. Each rule needs the shape of an attack, so `path.join(base, "../uploads")`, `$("#id")` and ordinary SQL pass. Secret values the finding or the diff shows are also removed wherever else they appear in the finding (a model that writes "rotate the key abc123..." in the recommendation). It runs twice: in the agent's `refine` over every text field, with one line of evidence kept (so the database and the dashboard never hold a secret), and in the publisher for any finding of category `security` (`sanitizeText` and `sanitizeLine` take `security`; the inline comment quotes one evidence line), so a finding from another source is cleaned the same way.
- **Output (FR-28).** `securityStatus(findings, state)` gives the overall status: `attention` (a critical or high finding with confidence of at least 0.8, `SECURITY_CALLOUT_CONFIDENCE`), `findings` (security findings, none of those), `clear` (agent finished, nothing found), `incomplete` (agent failed or timed out: "No finding does not mean the change is safe"), `not_run`, `off`. The summary has a **Security** block after the severity table: the status sentence, the call-outs in full (impact and mitigation) and the advisory line "Security review is advisory: it is not a replacement for SAST or dependency scanning." The call-outs are not repeated under "Findings"; other security findings are listed there as usual. The Check Run summary has a `**Security:**` line with the status and the advisory note, and its title ends with "(security attention needed)" for an `attention` status; the conclusion is unchanged (Phase 13 owns enforcement). The worker passes the agent's state to `renderCheckOutput` as `securityState`. Inline comments follow the normal thresholds; their footer says the review is advisory.
- **Dashboard.** The run detail page has a Security panel (status, call-outs, advisory line; border emphasis only for `attention`, the words carry the meaning) when the Security agent took part in the run, a category filter above the findings (`?category=` in the address, only categories the run has), and security findings carry a shield icon, the word "Security" and an accent bar. The status rules are repeated in `apps/web/src/lib/security.ts` because the web app imports only the api contract.
- **Scanner extension point (FR-27, `security/scanner.ts`).** `ScannerAdapter` (`id`, `formats`, pure `parse(input, context)` returning `{ findings, skipped, warnings }`), `scannerFinding` (builds a `Finding` with the platform's fingerprint so tool findings dedupe against the agent's), and `stubScannerAdapter`, the documented template. The header of the file lists the steps to add an adapter. Nothing fetches scanner output yet and the engine does not take adapters; both belong to a later phase.

## 11. Prompt design

- Prompts are versioned files; no inline strings.
- Each prompt has: role, task, severity/confidence rubric, output schema and the rule that content inside the delimiters is data that cannot change the rules, request tools, reveal secrets or alter the output format.
- Findings need a short quoted evidence snippet from the diff; no exploit payloads.

```
<<<UNTRUSTED_REPO_CONTENT id=7f3a9c>>>
...diff, PR text, repo instructions...
<<<END_UNTRUSTED_REPO_CONTENT id=7f3a9c>>>
```

## 12. Fingerprints and idempotency

- Fingerprint = first 16 hex chars of `sha256(filePath + normalizedTitle + category + floor(startLine / 5))`.
- Inline comments embed `<!-- ai-pr-review:fp=<id>;sha=<headSha> -->`; the summary comment embeds `<!-- ai-pr-review:summary -->`.
- Before posting, the worker checks `posted_comments` and the markers on GitHub; the same fingerprint for the same head SHA is not posted twice.
- Before publishing, the worker re-reads the PR head; if it changed, inline comments are skipped and the run becomes `superseded`.
- Only comments carrying our markers and authored by the App are ever edited.

## 13. Error taxonomy

| Error                                    | Where               | Result                                                                   |
| ---------------------------------------- | ------------------- | ------------------------------------------------------------------------ |
| Invalid webhook signature                | api                 | 401, nothing created                                                     |
| Duplicate delivery                       | api                 | 200/202, no-op                                                           |
| Guard says skip                          | api                 | `skipped` run with reason                                                |
| Quota exceeded                           | api                 | `skipped` run, reason `quota_exceeded`                                   |
| Missing / invalid provider credential    | worker              | `failed`, clear message, Check Run `neutral`                             |
| Provider timeout, 429, 5xx after retries | agent               | agent failed → run `partial`                                             |
| Malformed / schema-invalid output        | agent               | one repair retry, then dropped → `partial`                               |
| Invalid diff position                    | validator/publisher | dropped from inline, counted as suppressed                               |
| PR over size limits                      | context             | `partial` (limited) or `skipped`, with explanation                       |
| All agents fail                          | orchestrator        | `failed`; summary explains                                               |
| GitHub 403 (missing permission)          | publisher           | warning, publish what is possible, `neutral`                             |
| Redis/DB outage                          | worker              | job retried with backoff                                                 |
| Unhandled exception                      | worker              | run `failed`, Check Run completed `neutral`, error logged without source |

## 14. Enforcement

| Mode                | Check Run conclusion                                                      |
| ------------------- | ------------------------------------------------------------------------- |
| `comment_only`      | `success`; `neutral` if `partial`/`skipped`/`failed`                      |
| `warn`              | `neutral` if any finding meets the thresholds, else `success`             |
| `fail_on_threshold` | `failure` only if a finding meets both severity and confidence thresholds |

`failure` blocks merging only if the repository marks the check as required.

## 15. Frontend structure (`apps/web`)

Routes: `/login`, `/repos`, `/repos/:id/settings`, `/repos/:repoId/pulls/:number`, `/runs`, `/runs/:id`, `/findings`, `/findings/:id`, `/analytics`, `/installations/:id/settings`, `/installations/:id/audit`, `/account`. A typed API client is generated from the shared zod/OpenAPI contracts. Server state via TanStack Query; SSE events invalidate affected queries. Dark mode, responsive, keyboard accessible, no secrets in the client.

Implementation notes (Phase 10, `apps/web` and the run endpoints):

- **Structure.** `app/` (providers, auth guard, layout, query client), `pages/`, `components/` (status and severity badges, relative time, loading, empty and error states, theme toggle, account menu), `hooks/` (`queries.ts`, `useRunEvents.ts`), `lib/` (formatting, theme, shared clocks). Built now: `/login`, `/repos`, `/runs` (with `?view=pending`), `/runs/:id`, `/account`; `/findings` and `/analytics` are placeholders until Phase 14; `/repos/:id` and the settings routes arrive with Phase 14 (a repository links to `/runs?repo=<id>`). The api client comes from React context (`ApiContext`), so tests hand the app a client that points at a mock server. The web code imports `@ai-pr-review/shared/api` only (the package root pulls in Node-only code); the root is used for types.
- **Auth guard.** `useMe` is the one place that knows who is signed in: `GET /api/me`, where a 401 means "nobody" and not an error. Any other query that gets a 401 clears it (`QueryCache.onError`), which sends the guard to `/login` with "your session ended" and the page to return to. `return_to` is only ever a single-slash path. After sign-in with no installation the shell shows the onboarding (install link, "sign in again": the access list is read at sign-in).
- **Run list.** Filters live in the address (`repo`, `status`, `branch`, `from`, `to`, `view`); dates are whole days in the viewer's time zone; the branch applies 300 ms after typing stops. With no status filter, queued and running runs are fetched separately and pinned above the history (and left out of it), so a long history never pushes live work off screen. The pending view is the same list with `status=queued,running`. Paging follows the cursor (25 per page).
- **Run endpoints.** `GET /api/runs` takes the user's repository access (`listRepoAccess`, verified when stale) and passes the repository ids to `listRuns` (`repoIds`), so an installation's other repositories stay invisible to a member who cannot reach them. `GET /api/runs/:id` is the contract's third resource kind, `run`: the run is found among the user's installations, then repository access decides (404 for no access, like any other tenant's id). Responses are `snake_case` DTOs through the contract schema; the fingerprint, heartbeat, attempt counter and installation id never leave the api. `finding_counts` per run come from one grouped query (`countFindingsByRun`).
- **Event stream.** `GET /api/events` is a contract entry with `stream: "sse"`. One Redis subscription per api process (`RunEventHub`) feeds every open stream; each stream holds the set of repository ids its user can reach and drops events for others (an unknown repository triggers one re-check per five seconds). Every minute the stream re-reads access and checks the session without counting as activity (`SessionService.isActive`), so an idle session still times out while a tab is open; when it ends the stream sends `session.expired` and closes. The payload is `{ run_id, repo_id, status, at }`; the dashboard refetches through the authorised endpoints, so even a filtering bug could leak no run content. Frames: `retry: 3000`, `event: ready`, `event: run.updated`, `: heartbeat` every 15 s. Headers: `Cache-Control: no-store, no-transform`, `X-Accel-Buffering: no`, plus the usual security headers (it is a normal Fastify stream reply, so the hooks apply).
- **Who announces what.** The api publishes `run.updated` for a run it creates `queued` or `skipped` and for each run it supersedes (plus `run.cancel` to the worker); the worker publishes after every status change it makes. The api's webhook handler now enqueues to BullMQ (`BullJobQueue`) instead of logging.
- **Client resilience.** `useRunEvents` (mounted once, in the shell) opens `EventSource` with credentials, validates every message against `runUpdatedEventSchema`, and invalidates `runs`, the run itself and `repos`. `error` starts polling every 5 s (skipped while the tab is hidden; the window-focus refetch catches up); `open` after a gap stops polling and resyncs once; a closed source (the browser gave up) is replaced after 10 s while `me` is re-checked. The header shows "Live" or "Refreshing every few seconds" in words.
- **Look and accessibility.** Colour tokens are CSS variables (`styles.css`, light and `.dark`), mapped into Tailwind; every status and severity badge has a label and an icon, active runs also carry an accent bar. A test checks every foreground/background pair for 4.5:1 in both themes; Playwright runs axe (WCAG 2 A/AA) on every page in both themes and checks for no sideways scrolling at 375 px. Focus rings are global, a skip link leads to `#main`, the account menu is Radix (keyboard, Escape, focus return), motion respects `prefers-reduced-motion`. The theme follows the system until a choice is stored (localStorage, tolerated when blocked) and is applied from a module script, so the page needs no inline script (CSP `script-src 'self'`; avatars need `img-src https://avatars.githubusercontent.com`).

Implementation notes (Phase 14, history, analytics and settings):

- **New endpoints** (all in the contract, OpenAPI regenerated): `GET /api/findings` (filters `repo_id`, `run_id`, `severity`, `category`, `agent`, `status` = `posted` / `summary_only` / `suppressed` / `all` (default: reported, not suppressed), `path`, `from`, `to`, cursor), `GET /api/findings/:id`, `POST /api/findings/:id/feedback` (any user who can see the repository; a third resource kind `finding` resolves access through the finding's repository, 404 otherwise), `GET /api/repos/:id/pulls/:number/history`, `GET /api/analytics/summary` and `/timeseries`, `GET /api/installations/:id/audit` (admin) and `GET /api/repos/:id/export?kind=runs|findings` (admin, CSV, `download: "csv"` in the contract, 20,000 rows at most). The settings responses gained `repo_file` / `repo_file_keys` (filled from the default branch, cached a minute) and, for installations, `usage_today` and `retention`.
- **Findings carry** `suppressed_reason`, `github_url` (the inline comment when one was posted, else the file and lines at the reviewed commit, else null) and `feedback` (totals and the caller's own vote). One builder (`apps/api/src/findings/dto.ts`) serves the run detail, the explorer and a single finding.
- **Pull request history** compares consecutive reviews with the matcher the worker uses for the summary (`matchFindings`): new, still applicable, resolved (the agent that found it finished and the file was not left out) and not evaluated.
- **Analytics** are aggregate SQL over `review_runs(installation_id, repo_id, queued_at)` joined to findings, feedback and comments (`packages/db/src/tenant/analytics.ts`, definitions in its header and decision 76). Buckets are UTC days or ISO weeks; a range over 92 days is answered in weeks; ranges over 366 days are refused. Targets and their judging live in `packages/shared/src/api/analytics.ts` so the dashboard, the tests and the PRD agree.
- **Retention**: `RetentionJob` in the worker calls `deleteRunsOlderThan(RETENTION_DAYS)` at start and every `RETENTION_INTERVAL_MINUTES`.
- **Dashboard** adds `/findings`, `/findings/:id`, `/repos/:id/settings`, `/repos/:repoId/pulls/:number`, `/analytics`, `/installations/:id/settings` and `/installations/:id/audit`, a Re-run and Cancel bar on the run page (confirmation dialogs from Radix AlertDialog) and the previous-review tracking panel. The settings form is data (`lib/settingsFields.ts`): it validates with the shared config schema, builds a minimal patch (a reset sends `null`), locks the keys the repository file sets, and is read-only for non-admins. Keys are write-only (last four characters, test before save). Charts are in `components/charts` (decision 79).
- **Accessibility**: Playwright runs axe in light and dark and the phone-width check on every new page; the chart colours are checked for 3:1 in both themes in `contrast.test.ts`.

## 16. Deployment and operations

- Docker Compose services: `api`, `worker`, `web` (static, served by the api or a small reverse proxy), `postgres`, `redis`. Migrations run before `api` starts.
- Health: `/healthz` (process), `/readyz` (DB + Redis). Structured JSON logs with run ID, repo, PR number, status transitions, agent timings; no source content or secrets.
- Backups: documented PostgreSQL dump/restore; Redis is not a source of truth (runs are re-queueable from the database).
- Scheduled jobs: retention cleanup, stuck-run sweeper, installation sync (see the Phase 15 notes). Operations are in [operations.md](operations.md); what is sent and stored is in [privacy.md](privacy.md).

Implementation notes (Phase 15, hardening and operations):

- **Row-level security (adopted).** Migration `0006` enables RLS on every table that carries `installation_id` (and on `installations`) with one policy, `tenant_scope`, that calls `aipr_scope_allows(installation_id)`: the row is visible and writable when the session setting `aipr.scope` is `system`, or when `aipr.installation_ids` (a comma-separated list) contains it. With neither setting a session sees nothing. `createDb(url, { scope })` starts every connection of the **system** pool (worker, webhook handlers, jobs, re-run) with `aipr.scope = system` (a startup parameter, so it is on the connection before any query); the api's second, **tenant** pool announces nothing, and `registerEndpoint` runs every handler (except the SSE stream) inside `withInstallationScope(tenantDb, <the user's accessible installation ids>)`: one transaction with `set_config('aipr.installation_ids', …, true)`, so the setting ends with the transaction and never leaks into the pool. The data layer keeps its explicit `WHERE installation_id IN (...)`; the policy is the second wall for a query that forgets it. Inside that transaction the queries the data layer issues side by side (`Promise.all`) are queued on the one connection (`serializeQueries`), because node-postgres deprecates concurrent queries on a client. **What it does not cover:** a superuser, a role with `BYPASSRLS` and the table owner ignore the policies (`getRowSecurityStatus` checks the role at start-up and `/metrics` reports it); the system scope is a convention of the system pool, not a boundary against code that already runs SQL; a connection pooler must use session pooling. Tests: `packages/db/src/rls.test.ts` (a plain role runs unscoped SQL), a test that every table with `installation_id` has the policy, and the whole api suite, which now runs its handlers on the plain role.
- **Uninstall and suspend** (`deactivateInstallation`, `packages/db/src/system/lifecycle.ts`). In this order: the status changes (the dashboard hides the data and no webhook creates a run), queued and running runs are cancelled with the reason (one statement; a worker that holds one loses its fence, and the dashboard and the workers are told), and on **uninstall** the repositories are deactivated and the provider keys and the users' access caches are deleted at once. History stays until `RETENTION_DAYS` after `installations.status_changed_at`, when the worker's retention job purges the installation and, by cascade, everything it owns. A **suspended** installation keeps its keys and access (suspension is reversible) and is never purged. Both the webhook handler and the scheduled installation sync use the one function.
- **Access.** A viewer's installation access now also needs at least one repository of that installation that is still reachable (`AccessService.getInstallationAccess`, `listInstallationAccess`), so a person removed from GitHub loses the installation-level pages within `ACCESS_CACHE_TTL_SECONDS` as well as the repositories.
- **Abuse limits.** The webhook endpoint limits per client address, per bad signature (429 after the limit, so a prober is told to stop) and per installation (429, the delivery is **not** recorded, so GitHub's redelivery works later). `requestRun` decides the daily quota and the queue-depth limits (per installation and global) **inside the transaction that creates the run**, under an advisory lock per installation (`createRunSupersedingOlder(..., admit)`), so a burst cannot overshoot; a refusal is a `skipped` run whose reason starts `quota_exceeded` or `queue_limit`; a duplicate of an active run never reaches the decision. Fork pull requests, when an administrator opts in, are capped by `applyForkLimits` inside `collectContext` (15 files, 40,000 characters, 8 inline comments, 8 requests, 120,000 tokens; the caps only lower) and the summary says so.
- **Secrets in text.** `registerSecret` and `registerUrlSecret` (a connection string also registers its password) feed `maskRegisteredSecrets`, which `redactSecrets` applies first, so the secrets of the process (provider keys, the App key, tokens, the encryption key, the database password) are masked in prompts, in outgoing comments and, through `scrubFinding`, in the findings stored in the database, whatever their format. The credential "test connection" answer also drops the key it was given.
- **Secrets from files.** `loadEnv` supports `NAME_FILE` for every name in the schema (an explicit `NAME` wins; an unreadable file is reported by name only).
- **Scheduled jobs.** The worker's `RetentionJob` also purges uninstalled installations and trims the audit log (`AUDIT_RETENTION_DAYS`), webhook delivery records and stale access caches; `InstallationSync` reconciles every active installation's repositories with GitHub and runs the uninstall flow for one GitHub no longer knows, except when more than two and more than half look gone at once (that is a configuration error, not a wave of uninstalls).
- **Metrics.** `GET /metrics` (api, `METRICS_TOKEN` bearer, absent without a token, not proxied by the web server) computes its gauges at scrape time from PostgreSQL (`getOperationalStats`), BullMQ and a Redis hash of the GitHub rate-limit headers that the api and every worker record (`RedisRateLimitBoard`, fed by `GitHubAppAuth`'s `onRateLimit`), plus counters of this process. No tenant name or content. `docs/prometheus-alerts.yml` holds the alert rules; a test keeps them to metrics that exist.
- **Production stack.** `docker/Dockerfile` (one build, targets `api`, `worker`, `migrate`, `web`; no secrets; non-root; the backend bundles carry a `require` banner, without which they did not start), `docker-compose.prod.yml` (project `ai-pr-review-prod`; secrets as files through `*_FILE`; `migrate` as the owner role before `api` and `worker`; the apps connect as `aipr_app`; read-only filesystems, all capabilities dropped except the few PostgreSQL and Redis need; only `web` publishes a port), `docker/nginx` (one origin: static files plus a proxy for `/api`, `/auth`, `/webhooks`, `/healthz`, `/readyz`; the CSP, HSTS and the other headers; `/metrics` is 404; `X-Forwarded-For` trusted from private ranges only and rewritten, never forwarded). TLS is terminated in front.
- **Backups and chaos.** `scripts/ops/backup.sh` (custom-format `pg_dump`, `--no-owner --no-privileges`, listed to prove it reads), `restore.sh verify|replace` (a re-created database needs the application role's grants again: `docker/postgres/grants.sql`), `dashboard-check.mjs` (a throwaway session through the real stack). `npm run test:chaos` kills a real worker process and stops or destroys real Redis and PostgreSQL containers with reviews in flight and requires every run to end once.

Implementation notes (Phase 16, validation and release):

- **Acceptance suite** (`acceptance/`, vitest project `acceptance`): `endToEnd.test.ts` runs install → provider key → PR → pending → worker review → dashboard history → feedback → analytics → re-run through the real api, worker and publisher against PostgreSQL and in-memory fakes of GitHub and the provider; `enforcement.test.ts` is the AC-12 matrix; `performance.test.ts` checks a pull request at the size limits, the request and token budgets and the platform's own latencies; `traceability.ts` maps AC-1 to AC-23 to named tests and generates [acceptance.md](acceptance.md) (decisions 100 and 101).
- **Upgrade tests** (`packages/db/src/upgrade.test.ts`): for every earlier schema, a database is built at that version (the journal is cut), a tenant's history is inserted, the remaining migrations run, and the history and the final schema are compared with a fresh install.
- **Recorded real-provider runs** (`packages/core/src/agents/recordings.ts`): `RECORD=1 npm run review:fixtures` writes the model's answers and a hash of each request to `fixtures/recorded/`; `npm test` replays them and flags stale ones (decision 104).
- **Pilot tooling**: `npm run pilot:report` (`scripts/pilot-report.ts`) prints the PRD §13 metrics with counts, verdicts and token use by size class from the same aggregates the dashboard uses (decision 105). The protocol, the sandbox checklist and the SQL for the latencies that need real load are in [pilot.md](pilot.md).
- **Not changed**: no product code. Phase 16 adds proof, tooling and documentation only.

## 17. Out of scope

Billing, platform-paid keys, other Git hosts, executing repository code or tests, auto-fix patches, SSO/SAML, mobile apps, non-JS/TS deep analysis, scanner adapters beyond the interface.
