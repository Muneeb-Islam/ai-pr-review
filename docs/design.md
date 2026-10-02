# Technical Design

AI PR Review Platform. Source of truth for architecture, interfaces and behaviour. Read this with `scope.md`, `decision-log.md` and the current phase file at the start of every implementation session. If a phase file and this document disagree, this document wins; fix the phase file.

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
docs/  phases/  examples/  scripts/  docker/
```

Migration of the existing Action code (commit `b77c898`):

| Existing | Goes to | Notes |
|---|---|---|
| `src/types/*` | `packages/shared` | Unchanged. Add run/status types. |
| `src/config/*`, `schemas/*` | `packages/shared` | `fork_prs` becomes `skip \| review`. Split sensitive keys (§6). |
| `src/events/guards.ts` | `packages/core` (`routing`) | Pure `decide()` stays; the fork rule now follows `fork_prs`. |
| `src/events/router.ts`, `src/main.ts` | rewritten in `apps/api` | Action payloads → webhook handlers. |
| `src/github/client.ts` | `packages/core` (`github`) | Replace `@actions/github` with Octokit + App auth; keep retry/throttling. |
| `src/util/logger.ts` | `packages/shared` | Keep redaction rules. |
| `test/*` | alongside moved code | Keep and adapt. |
| `action.yml`, `dist/`, `scripts/build.mjs`, Action workflow, `examples/workflow.yml`, `scripts/local-run.mjs` | removed | Replaced by webhook replay script. |

## 3. Technology

| Area | Choice |
|---|---|
| Language / runtime | TypeScript (strict), Node.js (current LTS; repo already requires ≥ 24) |
| API | Fastify, zod for validation, OpenAPI generated from schemas |
| Database | PostgreSQL, Drizzle ORM + drizzle-kit migrations |
| Queue | Redis + BullMQ |
| GitHub | `@octokit/app`, `@octokit/core` with retry and throttling plugins, webhook verification |
| Auth | GitHub App user-to-server OAuth, server-side sessions in PostgreSQL, HttpOnly cookie |
| Frontend | React, Vite, React Router, TanStack Query, Tailwind CSS, accessible component primitives, Recharts |
| Realtime | Server-sent events (Redis pub/sub fan-out), polling fallback |
| Testing | Vitest; Testing Library for web; Playwright for dashboard smoke tests; Postgres/Redis via Docker in CI |
| Tooling | ESLint, Prettier, npm workspaces, GitHub Actions CI (this repo only) |

## 4. GitHub App

- **Permissions:** Metadata read; Contents read; Pull requests read & write; Checks read & write; Actions read (coverage artifacts); Issues read (GitHub requires it for the `issue_comment` event that carries `/ai-review`). Nothing else.
- **Events:** `pull_request`, `issue_comment`, `check_run` (rerequested), `installation`, `installation_repositories`. Optional later: `workflow_run`.
- **Webhook:** `POST /webhooks/github`. Verify `X-Hub-Signature-256` over the **raw body**; reject on mismatch; store `X-GitHub-Delivery`; respond `202` quickly; do all work asynchronously.
- **Auth:** App JWT → installation access token (cached until shortly before expiry). Tokens are never persisted or logged.
- **User login:** OAuth via the same App. The user token is only used to list the user's installations/repos and their permission on a repo.

## 5. Data model (PostgreSQL)

Every tenant table has `installation_id`; data access goes through helpers that require it (§9).

| Table | Key columns |
|---|---|
| `users` | id, github_user_id, login, avatar_url, created_at |
| `sessions` | id, user_id, expires_at, csrf_secret, created_at |
| `installations` | id, github_installation_id, account_login, account_type, status (`active`/`suspended`/`deleted`), created_at |
| `user_installations` | user_id, installation_id, role (`admin`/`viewer`), refreshed_at (cache of GitHub access) |
| `repositories` | id, installation_id, github_repo_id, full_name, default_branch, is_private, enabled, active |
| `repo_settings` | repo_id, config (jsonb, validated), updated_by, updated_at |
| `provider_credentials` | id, installation_id, repo_id (nullable), provider, ciphertext, key_version, last4, created_by, created_at |
| `webhook_deliveries` | delivery_id (unique), event, installation_id, received_at, processed_at, outcome |
| `review_runs` | id, repo_id, pr_number, head_sha, base_sha, base_ref, trigger, triggered_by, status, status_reason, check_run_id, summary_comment_id, queued_at, started_at, finished_at, parent_run_id, warnings (jsonb), usage (jsonb) |
| `agent_runs` | id, run_id, agent, status, started_at, duration_ms, input_tokens, output_tokens, retries, warnings |
| `findings` | id, run_id, repo_id, agent, category, severity, confidence, title, file_path, start_line, end_line, evidence (short), impact, recommendation, suggested_test, fingerprint, posted (bool), suppressed_reason |
| `posted_comments` | id, run_id, kind (`review_comment`/`summary`/`check`), github_id, fingerprint, head_sha |
| `finding_feedback` | finding_id, user_id, verdict (`useful`/`false_positive`/`known`), note, created_at |
| `audit_log` | id, installation_id, user_id, action, target, metadata, at |

Implementation notes (Phase 2, `packages/db`): the child tables `repo_settings`, `review_runs`, `agent_runs`, `findings`, `posted_comments` and `finding_feedback` carry `installation_id` and reference their parent through a composite foreign key `(installation_id, parent_id)`, so the database rejects a row whose installation differs from its parent's. `webhook_deliveries.delivery_id` is the primary key. Statuses, agents, severities, categories, verdicts and the like are Postgres enums built from the value lists in `packages/shared`. `findings.evidence` is `varchar(500)`; the data layer truncates longer text. Unscoped queries exist only in `@ai-pr-review/db/system`.

Implementation notes (Phase 3): `createRunSupersedingOlder` creates a `queued` run and supersedes the PR's other active runs in one transaction guarded by a per-PR advisory lock, returning the existing run when an identical active run (same head SHA and trigger) exists. A `webhook_deliveries` row with outcome `error` can be reclaimed by a redelivery of the same ID; any other row makes the redelivery a duplicate. See `phases/phase-03-github-app-and-webhooks.md` and `docs/github-app-setup.md`.

Indexes: `review_runs(repo_id, queued_at desc)`, `review_runs(status)`, `review_runs(repo_id, pr_number, head_sha)`, `findings(run_id)`, `findings(repo_id, severity)`, `webhook_deliveries(delivery_id)`. Retention deletes finished runs older than `RETENTION_DAYS` with their children (active runs are left to the sweeper).

## 6. Configuration

Effective config for a run = defaults < dashboard settings (`repo_settings.config`) < `.github/ai-pr-review.yml` read from the **base branch** at the base SHA, restricted to non-sensitive keys.

| Key group | Source | Notes |
|---|---|---|
| `provider`, `model`, `base_url`, `limits`, credentials | **dashboard only** | A repo file cannot choose where code is sent or raise cost limits. `base_url` must be HTTPS and must not resolve to private, loopback or link-local addresses. |
| `review.*`, `agents.*`, `coverage.*`, `ignore`, `secret_paths`, `instructions`, `fork_prs` | dashboard or repo file | Repo file wins when both set a key. |

```yaml
provider: deepseek            # anthropic | openai | deepseek   (dashboard only)
model: <model-id>             # dashboard only
base_url:                     # optional OpenAI-compatible endpoint, dashboard only
review:
  mode: comment_only          # comment_only | warn | fail_on_threshold
  target_branches: [main, master]
  draft_behavior: summary_only
  minimum_severity: medium
  minimum_confidence: 0.80
  max_changed_files: 40
  max_patch_characters: 120000
  max_inline_comments: 20
agents: { code_review: true, test_coverage: true, security: true, final_review: false }
coverage:
  artifact_name: coverage     # Actions artifact name
  lcov_path: lcov.info        # path inside the artifact
fork_prs: skip                # skip | review
ignore: ["dist/**", "coverage/**", "**/*.lock"]
secret_paths: ["**/.env*"]
instructions: ""
limits: { concurrency: 3, max_requests: 20, max_total_tokens: 400000, request_timeout_ms: 120000 }
```

Server environment (not per-repo): `DATABASE_URL`, `REDIS_URL`, `GITHUB_APP_ID`, `GITHUB_APP_PRIVATE_KEY`, `GITHUB_WEBHOOK_SECRET`, `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET`, `SESSION_SECRET`, `ENCRYPTION_KEY`, `PUBLIC_URL`, `RETENTION_DAYS`, quota defaults. Validated at startup; missing values fail fast with the variable name only.

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

REST under `/api`, JSON, zod-validated, session cookie + CSRF header on mutations. Cursor pagination on lists. Errors: `{ error: { code, message } }`. Cross-tenant access returns 404.

| Method & path | Purpose |
|---|---|
| `GET /auth/github/login` · `GET /auth/github/callback` · `POST /auth/logout` | Sign in / out |
| `GET /api/me` | Current user, installations, `install_url` |
| `GET /api/repos` · `GET /api/repos/:id` | Repos the user can see, with last-run summary |
| `GET/PATCH /api/repos/:id/settings` | Read / update settings (admin to write) |
| `PUT/DELETE /api/repos/:id/credentials` · `PUT/DELETE /api/installations/:id/credentials` | Write-only provider key |
| `GET /api/runs` | Filters: repo, status, branch, author, severity, from, to, cursor |
| `GET /api/runs/:id` | Run with agent runs, warnings, usage |
| `POST /api/runs/:id/rerun` · `POST /api/runs/:id/cancel` | Admin actions, audited |
| `GET /api/runs/:id/findings` · `GET /api/findings` | Findings explorer |
| `POST /api/findings/:id/feedback` | useful / false_positive / known |
| `GET /api/analytics/summary` · `GET /api/analytics/timeseries` | Metrics, filtered by repo and range |
| `GET /api/events` | SSE stream of `run.updated` for the user's repos |
| `POST /webhooks/github` | GitHub webhooks |
| `GET /healthz` · `GET /readyz` | Liveness / readiness |

## 9. Security model

- **Tenant isolation:** every data-access function takes the caller's accessible installation IDs. There is no unscoped query for tenant tables outside the worker. Authorisation tests cover every endpoint (AC-17). Row-level security is evaluated in Phase 15.
- **Authentication:** GitHub OAuth, server-side session, `HttpOnly; Secure; SameSite=Lax` cookie, CSRF token on mutations, short idle timeout, logout invalidates the session.
- **Authorisation:** viewer = any access to the repo through the installation; admin = GitHub admin permission on the repo or org owner. Access is re-checked against GitHub with a short cache (`user_installations.refreshed_at`).
- **Secrets:** provider keys use envelope encryption (AES-256-GCM, per-record data key wrapped by `ENCRYPTION_KEY` with a `key_version` for rotation). Keys are decrypted in the worker only, passed to the provider adapter in memory, never logged, never serialised into job payloads or API responses.
- **Webhooks:** raw-body signature check, constant-time compare, delivery-ID idempotency, payload size limit.
- **Outbound:** provider calls only to allow-listed hosts or a validated `base_url`; no tool access for agents.
- **Prompt injection:** repository text is wrapped in per-run randomised delimiters and treated as data; output is schema-validated; agents have no network, file or tool capability; only validated findings reach GitHub.
- **Repository config:** read from the base branch only; sensitive keys cannot come from the repo.
- **Browser:** strict CSP, no inline scripts, CORS restricted to the web origin, security headers via the api/static server.
- **Data minimisation:** no diffs or source persisted; evidence excerpts ≤ 500 characters; retention cleanup job.

## 10. Core engine interfaces (`packages/core`)

```ts
export type Severity = "critical" | "high" | "medium" | "low" | "info";
export type Category = "bug" | "security" | "test_gap" | "performance" | "maintainability";
export type AgentId = "code_review" | "test_coverage" | "security" | "final_review";
export type RunStatus =
  "queued" | "running" | "completed" | "partial" | "failed" | "skipped" | "superseded" | "cancelled";

export interface Finding {            // unchanged from PRD §12
  id: string; agent: AgentId; category: Category; severity: Severity; confidence: number;
  title: string; filePath?: string; startLine?: number; endLine?: number;
  evidence: string; impact: string; recommendation: string; suggestedTest?: string;
  sourceCommitSha: string;
}

export interface ChangedFile {
  path: string; previousPath?: string;
  status: "added" | "modified" | "removed" | "renamed";
  additions: number; deletions: number;
  patch?: string;
  addedLines: Array<{ start: number; end: number }>;
}

export interface ReviewContext {
  pr: { number: number; title: string; body: string; author: string;
        baseRef: string; baseSha: string; headSha: string; isDraft: boolean; isFork: boolean };
  files: ChangedFile[];                          // filtered; safe to send to a model
  skippedFiles: Array<{ path: string; reason: string }>;
  testFiles: Record<string, string[]>;
  prior: { fingerprints: string[]; summaryCommentId?: number };
  limits: { status: "ok" | "limited" | "skipped"; reason?: string };
  isLineInDiff(path: string, line: number): boolean;
}

export interface ProviderRequest {
  system: string; user: string; jsonSchema: object;
  maxOutputTokens: number; timeoutMs: number; signal?: AbortSignal;
}
export interface Provider {
  readonly name: "anthropic" | "openai" | "deepseek";
  complete(req: ProviderRequest): Promise<{
    json: unknown; usage: { inputTokens: number; outputTokens: number }; model: string; retries: number;
  }>;
}
// Errors: ProviderTimeout | ProviderRateLimit | ProviderUnavailable | ProviderAuthError | ProviderInvalidResponse

export interface AgentTask { agent: AgentId; context: ReviewContext; files: ChangedFile[];
                             config: ResolvedConfig; repoInstructions?: string; signal?: AbortSignal }
export interface AgentResult { agent: AgentId; status: "ok" | "failed" | "timeout" | "invalid_output";
                               findings: Finding[]; observations: string[];
                               coverage?: { status: "measured" | "not_available" | "skipped";
                                            changedLineCoverage?: number; observations: string[] };
                               durationMs: number; usage: { inputTokens: number; outputTokens: number };
                               retries: number; warnings: string[] }
export interface Agent { readonly id: AgentId;
                         run(task: AgentTask, deps: { provider: Provider; logger: Logger }): Promise<AgentResult> }

export interface FindingValidator { validate(findings: Finding[], ctx: ReviewContext, cfg: ResolvedConfig):
  { accepted: Finding[]; suppressed: Array<{ finding: Finding; reason: SuppressReason }> } }
export type SuppressReason =
  "below_threshold" | "invalid_line" | "no_evidence" | "duplicate" | "style_only" | "rejected_by_final_review";
```

The engine takes an Octokit instance, a decrypted provider key and an `AbortSignal` as parameters. It does not read the environment or the database.

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

| Error | Where | Result |
|---|---|---|
| Invalid webhook signature | api | 401, nothing created |
| Duplicate delivery | api | 200/202, no-op |
| Guard says skip | api | `skipped` run with reason |
| Quota exceeded | api | `skipped` run, reason `quota_exceeded` |
| Missing / invalid provider credential | worker | `failed`, clear message, Check Run `neutral` |
| Provider timeout, 429, 5xx after retries | agent | agent failed → run `partial` |
| Malformed / schema-invalid output | agent | one repair retry, then dropped → `partial` |
| Invalid diff position | validator/publisher | dropped from inline, counted as suppressed |
| PR over size limits | context | `partial` (limited) or `skipped`, with explanation |
| All agents fail | orchestrator | `failed`; summary explains |
| GitHub 403 (missing permission) | publisher | warning, publish what is possible, `neutral` |
| Redis/DB outage | worker | job retried with backoff |
| Unhandled exception | worker | run `failed`, Check Run completed `neutral`, error logged without source |

## 14. Enforcement

| Mode | Check Run conclusion |
|---|---|
| `comment_only` | `success`; `neutral` if `partial`/`skipped`/`failed` |
| `warn` | `neutral` if any finding meets the thresholds, else `success` |
| `fail_on_threshold` | `failure` only if a finding meets both severity and confidence thresholds |

`failure` blocks merging only if the repository marks the check as required.

## 15. Frontend structure (`apps/web`)

Routes: `/login`, `/repos`, `/repos/:id`, `/repos/:id/settings`, `/runs`, `/runs/:id`, `/findings`, `/analytics`, `/account`. A typed API client is generated from the shared zod/OpenAPI contracts. Server state via TanStack Query; SSE events invalidate affected queries. Dark mode, responsive, keyboard accessible, no secrets in the client.

## 16. Deployment and operations

- Docker Compose services: `api`, `worker`, `web` (static, served by the api or a small reverse proxy), `postgres`, `redis`. Migrations run before `api` starts.
- Health: `/healthz` (process), `/readyz` (DB + Redis). Structured JSON logs with run ID, repo, PR number, status transitions, agent timings; no source content or secrets.
- Backups: documented PostgreSQL dump/restore; Redis is not a source of truth (runs are re-queueable from the database).
- Scheduled jobs: retention cleanup, stuck-run sweeper, installation access refresh.

## 17. Out of scope

Billing, platform-paid keys, other Git hosts, executing repository code or tests, auto-fix patches, SSO/SAML, mobile apps, non-JS/TS deep analysis, scanner adapters beyond the interface.
