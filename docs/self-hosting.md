# Self-hosting guide

How to run the platform for your own organisation (or for others) with Docker Compose, from an empty Linux host to a first reviewed pull request. This page is the path; every step names the section of [operations.md](operations.md) that holds the detail (all variables, runbooks, alerts, upgrade and rollback). What reviews send to a provider and what is stored is in [privacy.md](privacy.md).

## What you need

| | |
|---|---|
| A Linux host | Docker with Compose v2, about 2 GB of memory for a small installation (more workers need more), a few GB of disk. The stack is `postgres` 17, `redis` 7, `migrate` (one-shot), `api`, `worker` and `web` (nginx). |
| A DNS name and TLS | The session cookie is `Secure`, so the dashboard works only over https. The stack does not terminate TLS: put Caddy, Traefik or a load balancer in front of the `web` container's port (8080 by default). |
| A GitHub account that can own an App | An organisation is best. You register **one GitHub App for production**. |
| An AI provider key | Per installation, entered later in the dashboard by an admin. Not needed to deploy. |
| Someone to own it | [operations.md section 1](operations.md#1-ownership-support-and-escalation): fill in the owner, on-call, security and privacy contacts before anyone outside your organisation uses it. |

## Steps

1. **Get the code.** `git clone` the repository at the release you want (`git checkout v1.0.0`). The images are built from it on the host; the only things pulled from a registry are the base images (Node.js, nginx) and PostgreSQL and Redis.

2. **Register the GitHub App** ([operations.md section 4](operations.md#4-the-production-github-app)). Set the homepage, callback (`https://<host>/auth/github/callback`) and webhook (`https://<host>/webhooks/github`) URLs, the permissions and events listed there, and nothing more. Generate the private key (a `.pem` file) and a client secret; note the App ID, client ID and slug.

3. **Create the secrets.**
   ```bash
   scripts/ops/init-secrets.sh
   ```
   It writes every random secret (webhook secret, session secret, encryption key, metrics token, database and Redis passwords) to `./secrets` and tells you the two files you must supply: `secrets/github_app_private_key` (the `.pem`) and `secrets/github_client_secret`. Paste the content of `secrets/github_webhook_secret` into the App's webhook secret field. **Copy the `secrets` directory to a password manager now, apart from where backups will go**: without `encryption_key`, stored provider keys cannot be read after a restore.

4. **Configure.**
   ```bash
   cp .env.production.example .env.production
   ```
   Set `PUBLIC_URL` (the https address people type), `GITHUB_APP_ID`, `GITHUB_CLIENT_ID`, `GITHUB_APP_SLUG`, and `VERSION` to the release. The rest has working defaults; the reference of every variable, with units and defaults, is [operations.md section 5](operations.md#5-environment-variables).

5. **Start.**
   ```bash
   docker compose -f docker-compose.prod.yml --env-file .env.production up -d --build
   ```
   The migration runs first and exits; `api` and `worker` start only after it succeeded; `web` after `api` is healthy.

6. **Check.**
   ```bash
   docker compose -f docker-compose.prod.yml ps        # every service healthy
   curl https://<your host>/readyz                     # {"status":"ready"}
   docker compose -f docker-compose.prod.yml logs api | grep "Row-level security"
   ```
   The log must say row-level security **is enforced**. If it says it is not, the api is connecting as a superuser or as the table owner ([operations.md section 6](operations.md#6-database-roles-and-row-level-security)).

7. **Install and try.** Open the dashboard, sign in with GitHub, follow **Install the GitHub App** on a test repository, add a provider key in the repository's settings (see the [user guide](user-guide.md)), open a pull request. A run appears as _queued_ within seconds and finishes with a review on the pull request. If nothing appears, _Advanced → Recent deliveries_ on the App's GitHub page shows what happened to the webhook ([admin-guide.md troubleshooting](admin-guide.md#troubleshooting)).

8. **Make it operable before you announce it.**
   - Monitoring: `/metrics` (its bearer token is the generated `secrets/metrics_token`) and the alert rules in [prometheus-alerts.yml](prometheus-alerts.yml) ([section 7](operations.md#7-monitoring)).
   - Backups: `scripts/ops/backup.sh` daily, `scripts/ops/restore.sh verify <dump>` after each, and a restore drill each quarter ([section 9](operations.md#9-backup-and-restore)).
   - Know the runbooks: worker stuck, Redis lost, PostgreSQL lost, a leaked key ([sections 10 and 11](operations.md#10-keys-and-secrets)).

## Day two

**Upgrade.** Back up and verify the backup, set `VERSION` to the new release, `up -d --build`. The migration runs before the new code starts; a failed migration leaves the old `api` and `worker` running. Read the release notes for new variables first. Rollback is `VERSION` back (migrations only add), or a restore if a migration cannot be lived with ([section 12](operations.md#12-upgrade-and-rollback)). Migrations are tested against every earlier schema with data in it (`packages/db/src/upgrade.test.ts`).

**Scale.** Reviews are the load; everything else is light.
- Run more workers: `docker compose -f docker-compose.prod.yml --env-file .env.production up -d --scale worker=3`. One worker process runs `WORKER_CONCURRENCY` reviews at once (default 4) and at most `WORKER_INSTALLATION_CONCURRENCY` (default 2) of one installation, so one busy organisation cannot starve the others.
- The limit that usually bites first is the **AI provider's rate limit** for the key, not your hardware. Per-run concurrency (`limits.concurrency`, default 3) and the daily quotas keep one installation inside it; if reviews queue for long, look at `aipr_queue_jobs` and at the provider's own limits before adding workers.
- Run more `api` replicas behind `web` only when dashboard reads become slow (the API read p95 on the test data is about 15 ms; it will not be the bottleneck for a long time). PostgreSQL and Redis are single instances in this stack: give them a managed service or a bigger host when you outgrow it (set `DATABASE_URL` and `REDIS_URL` to them and remove the containers).
- Redis holds only jobs; losing it loses nothing that cannot be rebuilt from PostgreSQL ([section 11](operations.md#11-recovery-runbooks)).

**Costs of running it.** The service itself is small; the money is the provider bill, which belongs to each installation's own key. [costs.md](costs.md) has typical sizes and ranges.

**Support.** Decide where users report problems and where you triage them, and put the address in your copy of the user guide. See [support in the release notes](release-notes-v1.0.0.md#support-and-feedback).
