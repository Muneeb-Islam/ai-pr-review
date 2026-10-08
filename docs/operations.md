# Operations: deploy, monitor, back up, upgrade, recover

For the **platform operator**: the person or team that runs this service. Everything here has been run against the real
stack in this repository (the exact checks are in section 12). Companion pages: [privacy.md](privacy.md) (what is sent and
stored), [github-app-setup.md](github-app-setup.md) (the development App), [design.md](design.md) §9 and §16.

## 1. Ownership, support and escalation

A hosted service has a long tail: support requests, abuse, incidents. **Before opening it to anyone outside your own
organisation, fill in this table and keep it where the on-call person can find it.**

| Role                                     | Who (fill in)       | What they decide                                                              |
| ---------------------------------------- | ------------------- | ----------------------------------------------------------------------------- |
| Owner of the service                     | _name, contact_     | Whether to suspend an installation, accept a risk, spend on capacity          |
| On-call operator                         | _name, rota, pager_ | First response to an alert; runs the runbooks below                           |
| Security contact                         | _address_           | Reports of leaked keys or abuse; decides on key revocation (section 10)       |
| Escalation if the owner cannot be reached | _name, contact_     | The same decisions                                                            |
| Data-protection / privacy contact        | _address_           | Erasure and access requests ([privacy.md](privacy.md))                        |

Escalation path: alert → on-call operator (acknowledge in 15 minutes) → owner (if not fixed in 1 hour, or at once for a
suspected key leak or cross-tenant exposure) → security contact. Write each incident down: what happened, what was done,
what changes. The usual causes and first moves are in section 11.

## 2. What runs

```
 internet ─ TLS ─►  web (nginx, :8080) ──┬─ /            static dashboard
 (your proxy)                             └─ /api /auth /webhooks ─► api (Fastify, :3000) ─┐
                                                                                            ├─► PostgreSQL 17
 GitHub ── webhooks ─► /webhooks/github ─► api ── BullMQ ─► Redis 7 ─► worker (reviews) ───┘
                                                              └──────► AI provider, GitHub API
```

`docker-compose.prod.yml` starts: `postgres`, `redis`, `migrate` (one-shot, as the owner role, before anything else),
`api`, `worker` and `web`. Only `web` publishes a port. All containers run as unprivileged users, with read-only root
filesystems and no Linux capabilities beyond what PostgreSQL and Redis need to start. Images are built by
`docker/Dockerfile` (multi-stage; the images that run hold bundled code and production dependencies only and **no
secrets**). Scale reviews by running more `worker` replicas (`docker compose up -d --scale worker=3`); the api can also
run several replicas behind the web server.

TLS is **not** terminated by this stack: the session cookie is `Secure`, so the dashboard works only over https. Put a load
balancer, Caddy or Traefik in front of `web:8080`, set `PUBLIC_URL` to the https address, and make that proxy the only
thing that can reach port 8080 (it should set `X-Forwarded-For` and `X-Forwarded-Proto`; the web server trusts those from
private address ranges only, see `docker/nginx/default.conf`).

## 3. First deployment

Needs a Linux host with Docker Compose v2, a DNS name, TLS in front, and about 2 GB of memory for a small installation.

1. **Register the production GitHub App** (section 4) and keep its id, client id, client secret and private key.
2. **Create the secrets:** `scripts/ops/init-secrets.sh` generates every random secret in `./secrets` (mode 700, never in
   git) and tells you which two files you must supply: `github_app_private_key` (the downloaded `.pem`) and
   `github_client_secret`. Set the App's webhook secret to the content of `secrets/github_webhook_secret`.
3. **Configure:** `cp .env.production.example .env.production` and set `PUBLIC_URL`, `GITHUB_APP_ID`, `GITHUB_CLIENT_ID`
   (and `GITHUB_APP_SLUG`).
4. **Start:** `docker compose -f docker-compose.prod.yml --env-file .env.production up -d --build`. The migration runs
   first; `api` and `worker` start only after it succeeded; `web` after `api` is healthy.
5. **Check:** `docker compose -f docker-compose.prod.yml ps` shows every service healthy;
   `curl https://<your host>/readyz` answers `{"status":"ready"}`; the api log says `Row-level security is enforced`
   (if it says NOT enforced, the api is connecting as a superuser or the table owner: see section 6); sign in; install the App
   on a test repository and open a pull request.
6. **Back up** the `secrets` directory (section 9) and take the first database backup.

Set up monitoring (section 7) before you announce the service.

## 4. The production GitHub App

Register a **separate App for production** (never reuse the development App). _GitHub → Settings → Developer settings →
GitHub Apps → New GitHub App_, owned by the organisation that operates the service. (`npm run github-app:register` automates
the same settings for a development App; see [github-app-setup.md](github-app-setup.md).)

| Setting                         | Value                                                                                                   |
| ------------------------------- | ------------------------------------------------------------------------------------------------------- |
| Homepage URL                    | `PUBLIC_URL`                                                                                            |
| Callback URL                    | `PUBLIC_URL/auth/github/callback`                                                                       |
| Request user authorization      | On ("Expire user authorization tokens" on; the token is used once at sign-in and not stored)             |
| Webhook URL                     | `PUBLIC_URL/webhooks/github`                                                                            |
| Webhook secret                  | The content of `secrets/github_webhook_secret`                                                          |
| Repository permissions          | Metadata: read · Contents: read · Pull requests: read & write · Checks: read & write · Actions: read · Issues: read |
| Organization permissions        | Members: read (tells an organisation owner from a member; without it organisation admins appear as viewers) |
| Subscribe to events             | Pull request · Issue comment · Check run · Installation · Installation repositories                     |
| Where can it be installed       | Any account (public product) or Only on this account (private deployment)                                |

Then: **Generate a private key** (a `.pem` file: that is `secrets/github_app_private_key`), **Generate a client secret**
(`secrets/github_client_secret`), and note the **App ID**, **Client ID** and the **slug** (the last part of
`github.com/apps/<slug>`). Nothing else is needed: no other permission, no other event. Compare the permissions your
App has with this table whenever you upgrade; the platform asks for nothing more.

Check after the first install: the delivery in the App's _Advanced → Recent deliveries_ shows `202`, and an `installation`
row appears (`aipr_installations{status="active"}` in the metrics).

## 5. Environment variables

Read from the environment, **or from a file**: `NAME_FILE=/path` supplies `NAME` from the file's content (trailing newline
removed), which is how the production stack passes every secret (Docker secrets mount them at `/run/secrets`). An explicit
`NAME` wins over `NAME_FILE`. Variables are validated at start-up; a bad or missing one stops the service with the variable's
**name** only, never its value.

**Required** (the service does not start without them): `api` needs `DATABASE_URL`, `REDIS_URL`, `GITHUB_APP_ID`,
`GITHUB_APP_PRIVATE_KEY`, `GITHUB_WEBHOOK_SECRET`, `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET`, `SESSION_SECRET`,
`ENCRYPTION_KEY`; `worker` needs `DATABASE_URL`, `REDIS_URL`, `GITHUB_APP_ID`, `GITHUB_APP_PRIVATE_KEY`, `ENCRYPTION_KEY`.

| Variable                                 | Used by         | Default                 | Meaning                                                                                                                                                                       |
| ---------------------------------------- | --------------- | ----------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `NODE_ENV`                               | all             | `development`           | `production` in the images: JSON logs by default, `Secure` cookies.                                                                                                           |
| `HOST`, `PORT`                           | api             | `127.0.0.1`, `3000`     | Bind address and port (the image binds `0.0.0.0`).                                                                                                                            |
| `DATABASE_URL`                           | api, worker     | —                       | PostgreSQL connection string. **Use the plain application role** (`aipr_app`), not a superuser or the owner: row-level security does not apply to those.                       |
| `MIGRATION_DATABASE_URL`                 | migrate         | `DATABASE_URL`          | The owner role that creates tables; used only by the migration.                                                                                                               |
| `MIGRATIONS_FOLDER`                      | migrate         | next to the script      | Where the SQL migration files are (the image sets it).                                                                                                                         |
| `REDIS_URL`                              | api, worker     | —                       | Redis connection string (`redis://:password@host:6379`).                                                                                                                      |
| `PUBLIC_URL`                             | api, worker     | `http://localhost:5173` | Where users reach the dashboard (https in production). CORS origin, OAuth return, links in comments.                                                                           |
| `API_PUBLIC_URL`                         | api             | `http://localhost:3000` | Public address of the api; the OAuth callback is `API_PUBLIC_URL/auth/github/callback`. Equal to `PUBLIC_URL` in the production stack (one origin).                              |
| `TRUST_PROXY`                            | api             | `false`                 | `true` behind a reverse proxy, so client addresses (rate limits) come from `X-Forwarded-For`. Only when the proxy overwrites that header (the stack's web server does).        |
| `GITHUB_APP_ID`                          | api, worker     | —                       | The App's numeric id.                                                                                                                                                         |
| `GITHUB_APP_PRIVATE_KEY`                 | api, worker     | —                       | The App's PEM key. Literal `\n` sequences are accepted for one-line values.                                                                                                   |
| `GITHUB_WEBHOOK_SECRET`                  | api             | —                       | Verifies `X-Hub-Signature-256` on the raw body.                                                                                                                               |
| `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET` | api           | —                       | The App's OAuth credentials (sign-in).                                                                                                                                        |
| `GITHUB_APP_SLUG`                        | api, worker     | looked up               | `github.com/apps/<slug>`: the "Install the App" link, and the account whose comments are the App's own.                                                                       |
| `SESSION_SECRET`                         | api             | —                       | At least 32 characters. Signs session and sign-in cookies, derives CSRF tokens. Changing it signs everyone out.                                                               |
| `ENCRYPTION_KEY`                         | api, worker     | —                       | 32 random bytes, base64. Wraps the data keys of stored provider keys. **Losing it makes every stored provider key unreadable.**                                                |
| `ENCRYPTION_KEY_VERSION`                 | api, worker     | `1`                     | Stamped on what `ENCRYPTION_KEY` wraps; raise it when you rotate (section 10).                                                                                                |
| `ENCRYPTION_KEY_PREVIOUS`, `ENCRYPTION_KEY_PREVIOUS_VERSION` | api, worker | unset       | The key being replaced, kept until `credentials:rotate` has re-wrapped everything.                                                                                            |
| `METRICS_TOKEN`                          | api             | unset                   | At least 16 characters. `GET /metrics` exists only when set, and needs `Authorization: Bearer <token>`.                                                                        |
| `LOG_FORMAT`                             | api, worker     | `json` in production    | `json` (one object per line) or `text`.                                                                                                                                       |
| `RETENTION_DAYS`                         | api, worker     | `90`                    | Finished runs, and uninstalled installations, are deleted after this many days.                                                                                               |
| `RETENTION_INTERVAL_MINUTES`             | worker          | `360`                   | How often each worker runs the clean-up.                                                                                                                                      |
| `AUDIT_RETENTION_DAYS`                   | worker          | `365`                   | Audit entries older than this are deleted.                                                                                                                                    |
| `WEBHOOK_DELIVERY_RETENTION_DAYS`        | worker          | `14`                    | Webhook delivery records older than this are deleted.                                                                                                                         |
| `ACCESS_REFRESH_INTERVAL_MINUTES`        | worker          | `60`                    | How often each worker reconciles installations and repositories with GitHub (catches a lost webhook).                                                                         |
| `QUOTA_RUNS_PER_DAY`, `QUOTA_TOKENS_PER_DAY` | api, worker | `200`, `2000000`        | Per installation, per UTC day. A run over the limit is recorded as skipped with the reason.                                                                                   |
| `QUEUE_MAX_QUEUED_PER_INSTALLATION`, `QUEUE_MAX_QUEUED_GLOBAL` | api | `100`, `2000`   | Runs waiting in the queue; one more is recorded as skipped (`queue_limit`).                                                                                                   |
| `WEBHOOK_RATE_LIMIT_PER_MINUTE`          | api             | `1200`                  | Webhook requests per client address.                                                                                                                                          |
| `WEBHOOK_BAD_SIGNATURE_LIMIT_PER_MINUTE` | api             | `20`                    | Requests with a bad signature per address before the answer becomes 429.                                                                                                      |
| `WEBHOOK_INSTALLATION_LIMIT_PER_MINUTE`  | api             | `300`                   | Events one installation may cause per minute; more are refused with 429 (not recorded, so they can be redelivered).                                                           |
| `WEBHOOK_MAX_BODY_BYTES`                 | api             | `5242880`               | Largest webhook body accepted.                                                                                                                                                |
| `RATE_LIMIT_PER_IP_PER_MINUTE`, `RATE_LIMIT_PER_USER_PER_MINUTE` | api | `300`, `120`    | Dashboard API limits per address and per signed-in user.                                                                                                                      |
| `SESSION_IDLE_TIMEOUT_MINUTES`, `SESSION_ABSOLUTE_TIMEOUT_HOURS` | api | `120`, `168`    | A session ends after this much idle time, and in any case this long after sign-in.                                                                                            |
| `ACCESS_CACHE_TTL_SECONDS`               | api             | `600`                   | How long cached GitHub access is trusted. Removed GitHub access is reflected within this time.                                                                                |
| `WORKER_CONCURRENCY`                     | worker          | `4`                     | Reviews one worker process runs at once.                                                                                                                                      |
| `WORKER_INSTALLATION_CONCURRENCY`        | worker          | `2`                     | Reviews of one installation at once, across all workers (fairness).                                                                                                           |
| `RUN_HEARTBEAT_INTERVAL_SECONDS`         | worker          | `10`                    | A running review proves it is alive this often.                                                                                                                               |
| `RUN_STUCK_TIMEOUT_SECONDS`              | api, worker     | `120`                   | Without a heartbeat for this long a run is stuck and the sweeper takes it over (also what `aipr_runs_stuck` counts).                                                          |
| `SWEEP_INTERVAL_SECONDS`                 | worker          | `30`                    | How often each worker looks for stuck runs and for queued runs that lost their job.                                                                                           |
| `JOB_MAX_ATTEMPTS`, `RUN_MAX_ATTEMPTS`   | api, worker     | `5`, `3`                | Attempts per job for infrastructure errors; times a run may be started before it is failed.                                                                                   |
| `SHUTDOWN_GRACE_SECONDS`                 | worker          | `30`                    | On stop, running reviews get this long to finish before they are handed back to the queue.                                                                                    |
| `WORKER_LIVENESS_FILE`                   | worker          | temp dir                | The file the worker touches for its container health check.                                                                                                                   |

Compose-level (`.env.production`, not read by the services): `VERSION` (image tag), `WEB_PORT` (published port).
Development only: `POSTGRES_PORT` (`docker-compose.yml`), `API_URL` and `WEB_PORT` (the Vite dev proxy), `VITE_API_URL` (a
separate-origin dashboard build), and `DEEPSEEK_API_KEY`, `ANTHROPIC_API_KEY`, `OPENAI_API_KEY` for the local provider
scripts. Provider keys for real reviews are entered in the dashboard and stored encrypted.

## 6. Database roles and row-level security

PostgreSQL enforces tenant isolation as a second wall behind the application code (migration `0006`): every tenant table has
a policy that shows a session only the installations it names. The policies apply to a role that is **not** a superuser, does
**not** have `BYPASSRLS` and does **not** own the tables. The stack therefore uses two roles:

- the **owner** (`aipr`, the bootstrap role) owns the tables and is used only by `migrate`;
- **`aipr_app`**, created by `docker/postgres/init-roles.sh` and granted by `docker/postgres/grants.sql`, is what `api` and `worker`
  connect as. It can read and write tables; it cannot change the schema or switch the policies off.

The worker and the webhook handlers announce `aipr.scope = system` on their connections (they act for the platform and read
across tenants by design); the dashboard's handlers run in a transaction that names only the signed-in user's installations.
`aipr_row_level_security_enforced` in `/metrics` and the start-up log line tell you whether the role you configured is
subject to the policies. **If you use a managed PostgreSQL**, create the two roles yourself, run `docker/postgres/grants.sql`
as the owner, and put the plain role's URL in `DATABASE_URL`. **Pooling:** a transaction-mode connection pooler (PgBouncer)
cannot carry the session setting the worker relies on; use session pooling or connect directly.

## 7. Monitoring

### Health and readiness

- `GET /healthz`: the process is up. `GET /readyz`: PostgreSQL and Redis both answer within two seconds (503 otherwise). Both
  are open and say nothing else. Use `/readyz` for load balancer checks.
- The containers have health checks (api: `/readyz`; worker: a liveness file it touches every ten seconds; web: its own
  endpoint). `docker compose ps` shows them; `restart: unless-stopped` restarts a process that exits.

### Metrics

`GET /metrics` on the api, in the Prometheus text format, behind `Authorization: Bearer <METRICS_TOKEN>`. It is **not**
reachable through the web server (404): scrape `api:3000` from inside the network. It reads PostgreSQL, Redis and the
queue when scraped, so any api replica gives the same answer, and it names no repository, user or content.

| Metric                                           | Meaning                                                                                                         |
| ------------------------------------------------ | --------------------------------------------------------------------------------------------------------------- |
| `aipr_up`                                        | The api answered.                                                                                               |
| `aipr_dependency_up{dependency}`                 | `postgres` / `redis` answered during this scrape.                                                               |
| `aipr_runs_active{status}`                       | Runs `queued` and `running` now.                                                                                |
| `aipr_oldest_queued_run_age_seconds`             | How long the oldest queued run has waited. **The queue-stuck signal.**                                          |
| `aipr_runs_stuck`                                | Running runs without a heartbeat for `RUN_STUCK_TIMEOUT_SECONDS`.                                               |
| `aipr_runs_finished_24h{status}`                 | Runs that ended in the last 24 hours, by final status.                                                          |
| `aipr_run_failure_ratio_24h`                     | `failed` over completed + partial + failed, last 24 hours.                                                      |
| `aipr_run_duration_seconds_24h{quantile}`        | Start-to-finish time of completed and partial runs: median and 95th percentile.                                 |
| `aipr_tokens_24h{direction}`                     | Provider tokens reported by runs that ended in the last 24 hours.                                               |
| `aipr_queue_jobs{state}`                         | BullMQ jobs: waiting, active, delayed, failed.                                                                  |
| `aipr_dead_letter_jobs`                          | Jobs that ran out of retries; each is a run that failed with a message. Look at them.                           |
| `aipr_webhook_deliveries_24h{state}`             | Webhook deliveries received, failed (ended in an error), unprocessed (older than 5 minutes and never finished). |
| `aipr_webhook_requests_total{result}`            | This api process's webhook answers: accepted, duplicate, invalid_signature, rate_limited, installation_rate_limited, bad_request. |
| `aipr_http_requests_total{route,status}`         | Dashboard API requests by route pattern and status class.                                                       |
| `aipr_http_rate_limited_total{scope}`            | Requests refused by a rate limit (`ip`, `user`).                                                                |
| `aipr_github_rate_limit_remaining{installation}` | Requests left in GitHub's window for the 20 installations closest to the limit.                                 |
| `aipr_github_rate_limit_ratio_min`               | The smallest remaining/limit ratio over installations seen in the last hour (1 = untouched, 0 = exhausted).     |
| `aipr_installations{status}`                     | Installations by status.                                                                                        |
| `aipr_row_level_security_enforced`               | 1 when the database role is subject to the tenant policies.                                                     |

### Alerts

[`prometheus-alerts.yml`](prometheus-alerts.yml) is a starting set in Prometheus format (a test keeps it in step with the
metrics above). The ones that matter first:

| Alert                  | Condition                                                         | First move                                                                                  |
| ---------------------- | ----------------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| Queue stuck            | `aipr_oldest_queued_run_age_seconds > 600` for 5 minutes          | Are workers up (`docker compose ps worker`)? Is Redis up? Section 11, "Nothing is reviewed". |
| Runs stuck             | `aipr_runs_stuck > 0` for 5 minutes                               | A worker died; the sweeper recovers it within `RUN_STUCK_TIMEOUT_SECONDS`. If it persists, restart the workers. |
| Failure spike          | `aipr_run_failure_ratio_24h > 0.3` for 15 minutes                 | Open recent failed runs: the reason is on each (a provider outage, a revoked key, GitHub). |
| Webhook failures       | `aipr_webhook_deliveries_24h{state="failed"} > 0` for 10 minutes  | Check the api log for `Webhook processing failed`; GitHub's _Recent deliveries_ can redeliver. |
| Forgery or probing     | `rate(aipr_webhook_requests_total{result="invalid_signature"}[5m]) > 0.2` | A wrong webhook secret (after a rotation) or someone probing; see section 10.            |
| Dead letters           | `aipr_dead_letter_jobs > 0`                                       | `docker compose logs worker`; the run says why it failed.                                   |
| GitHub rate limit      | `aipr_github_rate_limit_ratio_min < 0.1`                          | One installation is using its window; reviews of it slow down by design.                    |
| Isolation not enforced | `aipr_row_level_security_enforced == 0`                           | The database role is wrong (section 6). Fix before the next deploy.                         |
| Dependency down        | `aipr_dependency_up == 0` for 2 minutes                           | PostgreSQL or Redis: section 11.                                                            |

### Logs

Structured JSON, one object per line on stdout (`time`, `level`, `msg`, `app`, then fields such as `run`, `repo`, `pr`,
`status`, `agent`, `durationMs`, `request`). They never contain code, diffs, tokens or keys: a field named like a secret is
masked, and every registered secret and every known token format is removed from every line. Ship them to your collector
(`docker compose logs`, the Docker logging driver) and keep them no longer than your policy ([privacy.md](privacy.md)).
Find one request by the `X-Request-Id` the api returns; one run by its id (the dashboard URL).

### Scheduled jobs

| Job                 | Where           | Does                                                                                                                      |
| ------------------- | --------------- | ------------------------------------------------------------------------------------------------------------------------- |
| Stuck-run sweeper   | every worker    | Every `SWEEP_INTERVAL_SECONDS`: takes over runs whose worker stopped (back to the queue, or failed after `RUN_MAX_ATTEMPTS`) and re-adds the job of queued runs that lost it. |
| Retention clean-up  | every worker    | Every `RETENTION_INTERVAL_MINUTES`: deletes old finished runs with findings, comments and feedback; purges installations uninstalled longer ago than `RETENTION_DAYS`; trims the audit log, delivery records and stale access caches. |
| Installation sync   | every worker    | Every `ACCESS_REFRESH_INTERVAL_MINUTES`: compares each installation's repositories with GitHub (adds, deactivates) and runs the uninstall flow for an installation GitHub no longer knows. It refuses to act if most installations look gone at once (a sign of wrong App credentials). |
| Session sweeper     | api             | Hourly: deletes expired and idle sessions.                                                                                |

All are safe to run from several processes at once.

## 8. Limits and abuse protection

| Layer                  | Limit                                                                                                                                                                                            |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Webhook endpoint       | Per client address, per bad signature, per installation (section 5). Invalid signatures create nothing.                                                                                          |
| Dashboard API          | Per address and per user; stricter for "test connection". Mutations need the CSRF token and a same-origin request.                                                                               |
| Queue                  | At most `QUEUE_MAX_QUEUED_PER_INSTALLATION` runs waiting per installation and `QUEUE_MAX_QUEUED_GLOBAL` overall; decided in the transaction that creates the run, so a burst cannot overshoot.      |
| Daily quota            | Runs and tokens per installation per UTC day; checked when the run is created and again when it starts.                                                                                          |
| Per run                | Files, characters, requests and tokens per review (the repository's limits, dashboard-only).                                                                                                      |
| **Fork pull requests** | Skipped by default (`fork_prs: skip`). When an administrator opts in they are reviewed under stricter caps: 15 files, 40,000 characters, 8 inline comments, 8 requests, 120,000 tokens. No code of a fork is ever fetched or run; the provider key is used only by the provider adapter. |

Every refusal that stops a review leaves a visible `skipped` run with the reason (`quota_exceeded`, `queue_limit`, fork, draft…),
so "why was my pull request not reviewed?" is answered in the dashboard.

To stop an abusive installation: suspend it by hand (this stops its queued runs and hides it), and tell its owner why:

```bash
docker compose -f docker-compose.prod.yml exec -T postgres psql -U aipr -d aipr -c \
  "update installations set status = 'suspended', status_changed_at = now() where github_installation_id = <id>"
```

Suspending on GitHub's side (the App's _Suspend_ button on the installation) does the same through the `installation` event.

## 9. Backup and restore

### What to back up

| What                                  | How                                                                      | Notes                                                                                                                  |
| ------------------------------------- | ------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------- |
| PostgreSQL                            | `scripts/ops/backup.sh [dir]`: `pg_dump` in custom format, then listed to prove it is readable | Daily at least, and before every upgrade. Keep 7 daily and 4 weekly, off the host. Expire them: a backup is a copy of data that the retention rules delete. |
| The `secrets` directory               | Copy it to a password manager or a secrets vault                         | **Store it apart from the dumps.** Without `encryption_key` the stored provider keys in a restored database cannot be read (users would have to enter them again); the other secrets are replaceable (section 10). |
| `.env.production`                     | Copy it with the secrets                                                 | Not secret, but you need it to bring the stack up.                                                                     |
| Redis                                 | Not backed up                                                            | It only carries jobs. Everything in it is rebuilt from PostgreSQL (section 11, "Redis lost").                          |

### Restore

`scripts/ops/restore.sh verify <dump>` restores into a scratch database, prints what it holds (migrations, installations,
repositories, runs, findings, stored keys, the number of row-level-security policies) and drops it. **Run it after every
backup job, and as a drill each quarter.**

To replace the live database after a loss:

```bash
scripts/ops/restore.sh replace backups/aipr-<stamp>.dump --yes
node scripts/ops/dashboard-check.mjs --url https://<your host>
```

`replace` stops web, api and worker; re-creates the database; loads the dump; **re-applies the application role's
grants** (a dump made with `--no-privileges` carries none, and a re-created database starts without any: without this step
the api cannot read its own tables); runs the migration for anything newer than the dump; and starts the stack. Runs that
were queued or running at backup time are picked up by the sweeper. The dashboard check signs in a throwaway user, asks
the running stack (through the web address people use) for the user, the repositories and the runs, compares the counts
with the database and removes the user.

To restore onto a **new host**: install Docker, copy the repository, `secrets` and `.env.production`, run
`docker compose -f docker-compose.prod.yml --env-file .env.production up -d postgres redis`, then `restore.sh replace`.
Point DNS and the App's URLs at the new host.

## 10. Keys and secrets

| Secret                         | If it leaks, or on rotation                                                                                                                                                    |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| A user's **provider key**      | Revoke it at the provider first (the copy may exist elsewhere), then delete or replace it in the dashboard. Reviews that use it fail with "no key" until a new one is entered. |
| `ENCRYPTION_KEY`               | Rotate (below). With a database dump an attacker could decrypt every provider key: revoke **all** of them at their providers, too (`revoke-credentials.js --all`, below).             |
| `GITHUB_APP_PRIVATE_KEY`       | On GitHub, generate a new private key for the App, put it in `secrets/github_app_private_key`, `docker compose … up -d api worker`, then **delete the old key** on GitHub.   |
| `GITHUB_WEBHOOK_SECRET`        | Change it on the App and in `secrets/github_webhook_secret` together, restart `api`. Deliveries in between fail the signature check (401): redeliver them from GitHub.      |
| `GITHUB_CLIENT_SECRET`         | Generate a new one on the App, replace the file, restart `api`. Sign-in fails in between.                                                                                      |
| `SESSION_SECRET`               | Replace the file, restart `api`. Everyone is signed out.                                                                                                                       |
| `METRICS_TOKEN`                | Replace the file, restart `api`, update the scraper.                                                                                                                           |
| Database or Redis password     | Change it in PostgreSQL/Redis and in the matching secret files (`database_url`, `redis_url`, `redis_conf`…), restart the services.                                              |

### Rotating the encryption key

Tested end to end by `apps/worker/src/keyRotation.test.ts`: reviews run before, during and after.

1. `openssl rand -base64 32` is the new key. In `.env.production` set `ENCRYPTION_KEY_VERSION` to the old version + 1; write
   the new key to `secrets/encryption_key` **after** copying the old one to a new secret file `encryption_key_previous`.
2. Give the services the old key as `ENCRYPTION_KEY_PREVIOUS_FILE=/run/secrets/encryption_key_previous` and
   `ENCRYPTION_KEY_PREVIOUS_VERSION=<old version>` (add the secret and the variables to `api` and `worker` in the Compose file) and
   restart them. They write new keys with the new key and still read old ones with the old.
3. `docker compose -f docker-compose.prod.yml --env-file .env.production run --rm worker node dist/rotate-credentials.js`
   (the same environment as the worker, so it sees both keys). It re-wraps every stored key's data key without decrypting a secret
   and says `N rotated, 0 already current, 0 failed`. Run it again: it reports nothing left. (From a checkout: `npm run credentials:rotate`.)
4. Remove the previous key from the services and the Compose file, restart. The old key is now useless: a process that still
   holds only it reports "could not be read" and uses nothing.

### Emergency: revoking keys

1. **At the provider**, revoke the key or keys (this is what stops misuse; the next steps stop the platform using them).
2. `docker compose -f docker-compose.prod.yml --env-file .env.production run --rm worker node dist/revoke-credentials.js --installation <GitHub installation id>`
   deletes one installation's stored keys; `… --all` deletes all of them. The next review of an affected repository fails with
   "No API key is stored" and posts nothing. (From a checkout: `npm run credentials:revoke -- --all`.)
3. Tell the affected administrators to enter new keys. If `ENCRYPTION_KEY` itself was exposed, rotate it as above.
4. If the App's private key or webhook secret leaked, rotate those too (table above) and look in the audit log
   (dashboard → installation → Audit) for changes you did not expect.

## 11. Recovery runbooks

**Nothing is reviewed** (queue stuck alert): `docker compose ps`. A worker that is down: `up -d worker`. Redis down: below.
PostgreSQL down: below. All up but runs stay queued: `aipr_queue_jobs` and the worker log; restart the workers. A review
that is running with no heartbeat is taken over by the sweeper within `RUN_STUCK_TIMEOUT_SECONDS`.

**A worker is killed** (power loss, `kill -9`, out-of-memory): nothing to do. Its running runs stop sending heartbeats, the
sweeper of any other worker puts them back in the queue (or fails a run that has killed `RUN_MAX_ATTEMPTS` workers), and they
run again from the start. The results of a run are written under a fence of the attempt number, so a worker that comes back
late cannot overwrite its replacement. If no worker is left, start one: the runs are picked up.

**Redis stopped for a while:** the api answers webhooks with an error only if it cannot reach the queue (GitHub shows the
delivery as failed; redeliver it); reviews in progress retry their infrastructure calls with backoff and continue when Redis
returns. Nothing is lost.

**Redis lost** (container destroyed, data wiped, replaced by an empty instance): the queue is not a source of truth. Start
Redis, restart `api` and `worker`. Every run that is `queued` in the database but has no job is re-added by the sweepers within
about `max(RUN_STUCK_TIMEOUT_SECONDS / 2, 30)` seconds plus one sweep interval; a run that was running loses its heartbeat and is
taken over the same way. To check: `aipr_runs_active{status="queued"}` falls to zero and
`aipr_oldest_queued_run_age_seconds` returns to 0. No run is reviewed twice (a duplicate job does nothing: the run's state is
fenced in PostgreSQL). **Dead-letter jobs and the live dashboard stream are lost with Redis**: the stream reconnects by itself.

**PostgreSQL stopped for a while:** `/readyz` answers 503; the dashboard shows errors; webhooks are not recorded (GitHub
shows a failed delivery: redeliver them when it is back); workers retry with backoff and a run that was in flight goes back to the
queue. When PostgreSQL returns everything continues. For a damaged or lost database: restore (section 9).

These three outcomes (worker killed, Redis stopped and replaced, PostgreSQL stopped) are exercised for real by
`npm run test:chaos`: reviews are in flight, a real worker process is killed or its Redis/PostgreSQL container is stopped or
destroyed, and every run must still end `completed` with exactly one agent run and one finding each.

**A webhook was missed:** GitHub → the App → Advanced → Recent deliveries → Redeliver. The installation sync also corrects
repository selections and uninstalls within an hour.

**A user cannot see a repository, or sees one they should not:** access is checked against GitHub and cached for
`ACCESS_CACHE_TTL_SECONDS` (10 minutes). Ask them to sign in again; removal of access takes effect within the cache time.

## 12. Upgrade and rollback

Migrations are forward-only and additive where possible; the images and the schema are versioned together by `VERSION`.

**Upgrade**

1. Read the release notes for migrations and new variables ([section 5](#5-environment-variables)).
2. `scripts/ops/backup.sh` and `scripts/ops/restore.sh verify <the new dump>`. Do not skip this: it is the rollback.
3. `git pull` (or fetch the release), set `VERSION=<release>` in `.env.production`.
4. `docker compose -f docker-compose.prod.yml --env-file .env.production up -d --build`. `migrate` runs first and exits;
   `api` and `worker` start only if it succeeded. A failed migration leaves the old `api` and `worker` running.
5. Check: `ps` (all healthy), `/readyz`, the log line `Row-level security is enforced`, the metrics, and
   `node scripts/ops/dashboard-check.mjs --url https://<host>`.

**Rollback**

- **Images only, no migration ran** (or it was additive): set `VERSION` back and `up -d`. Older code runs against a schema
  with extra columns; the migrations of this project add, they do not drop.
- **A migration that the old version cannot live with, or data damaged by the new version:** `scripts/ops/restore.sh replace
  <the dump from step 2> --yes` with `VERSION` set back first. Everything written since that backup is lost: say so.

**Zero-downtime notes:** webhooks that arrive while the api restarts are redelivered by GitHub if you ask (or lost if nobody
does): upgrade at a quiet time, and check _Recent deliveries_ afterwards. The worker finishes its reviews before it stops
(`stop_grace_period` 45 s) and hands the rest back.

## 13. Erasing data now

For an uninstalled installation the platform purges after `RETENTION_DAYS`. To erase immediately (a request under
[privacy.md](privacy.md)), after the App has been uninstalled (otherwise a webhook would recreate it):

```bash
docker compose -f docker-compose.prod.yml exec -T postgres psql -U aipr -d aipr -c \
  "delete from installations where github_installation_id = <id> and status = 'deleted'"
```

Everything the installation owns (repositories, settings, keys, runs, findings, feedback, comments, audit entries) goes with it
by cascade. Backups keep their copy until they expire. To remove one person: `delete from users where login = '<login>'`
removes their sessions and cached access; their feedback keeps its text but loses the link to them.

## 14. What has been verified

| Claim                                                                  | Where it is tested                                                                                                         |
| ---------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| Every route is in the contract or listed; anonymous, other tenant, viewer and admin behave as specified | `apps/api/src/routes.test.ts`, `authorization.test.ts`                                                                      |
| The database refuses cross-tenant reads and writes by itself            | `packages/db/src/rls.test.ts`; every api test runs the handlers on the unprivileged role                                    |
| Planted secrets never reach a prompt, a log, a response, a comment or the database | `apps/worker/src/hardening.test.ts`, `apps/api/src/canary.test.ts`                                                  |
| Prompt injection changes no outbound call and posts nothing it should not | `apps/worker/src/hardening.test.ts` (prompt injection)                                                                    |
| Fork pull requests are capped and never see a key                       | `packages/core/src/context/hardening.test.ts`, `apps/worker/src/hardening.test.ts`                                         |
| Headers, cookies, CORS, CSRF, session fixation                          | `apps/api/src/webSecurity.test.ts`, `apps/web/e2e/csp.spec.ts`                                                             |
| Rate limits, queue and quota limits, 200 events in a burst              | `apps/api/src/hardening.test.ts`                                                                                           |
| Uninstall, suspend, purge, retention                                    | `apps/api/src/hardening.test.ts`, `packages/db/src/lifecycle-hardening.test.ts`, `apps/worker/src/retention.test.ts`        |
| Key rotation and revocation, step by step                               | `apps/worker/src/keyRotation.test.ts`                                                                                      |
| Worker kill, Redis and PostgreSQL loss                                  | `apps/worker/chaos/chaos.test.ts` (`npm run test:chaos`)                                                                   |
| The production images build and the stack runs; backup, restore and the dashboard check | Checked by hand against `docker-compose.prod.yml` (not run in CI); the runbooks above are the procedure |
| Dependency audit                                                        | CI runs `npm audit --audit-level=high` on every push                                                                       |
