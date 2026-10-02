# Phase 15 – Hardening, Multi-Tenancy & Operations

**Depends on:** Phases 12–14  
**Unblocks:** Phase 16  
**Refs:** AC-9, AC-17, AC-18, AC-20, AC-22, AC-23, PL-08, PL-11, PL-16, PL-17, design §9, §16

## Goal

Make the platform safe to host for other people: strong tenant isolation, protection of secrets and code, abuse limits, and a deployment that can be operated, monitored, backed up and upgraded.

## Tasks

### Multi-tenancy and access (AC-17, AC-22)
- [ ] Authorisation test suite that exercises every endpoint as anonymous, another tenant, viewer and admin; fail the build if a new route has no entry.
- [ ] Evaluate PostgreSQL row-level security as defence in depth for tenant tables; adopt it if it can be done without breaking the worker's system access.
- [ ] Uninstall and suspend flows: deactivate access, hide data from the dashboard, stop queued runs, schedule deletion at retention end.
- [ ] Access cache: removed GitHub access is reflected within the cache TTL.

### Fork PRs and abuse (AC-9, AC-23)
- [ ] Verify end to end: no code is ever checked out or executed; provider keys never reach any code path that handles PR-controlled data other than the model request; `fork_prs: skip` default holds.
- [ ] When fork review is enabled, apply stricter per-PR limits and the installation quotas; record quota skips visibly.
- [ ] Rate limits on API and webhook endpoints; global and per-installation queue limits.

### Secrets and prompt injection (AC-18)
- [ ] Planted-canary tests: fake keys and secrets in the environment, repo files, PR text and database must never appear in provider requests, logs, API responses or posted comments.
- [ ] Prompt-injection fixtures: code comments, README text, PR descriptions and base-branch instruction files telling the model to leak secrets, change output, approve the PR or call tools. Assert only schema-valid findings come out and the set of outbound calls is unchanged.
- [ ] Confirm repository instructions cannot override system rules or choose provider, endpoint or limits.
- [ ] Key rotation procedure tested end to end; document emergency key revocation.

### Web security
- [ ] CSP without inline scripts, HSTS, frame protection, referrer policy, CORS limited to the web origin, cookie flags verified, session fixation and CSRF tests, dependency audit of all packages, pinned third-party Actions in CI.

### Data lifecycle (PL-08, AC-20)
- [ ] Retention cleanup job tested (runs, findings, comments, feedback removed together); audit log retention defined; stuck-run sweeper and access refresh jobs scheduled.
- [ ] `docs/privacy.md`: what is sent to which provider (including the DeepSeek notice), what is stored, how long, how to delete data.

### Operations (PL-16, PL-17)
- [ ] Production Docker Compose and images (multi-stage, non-root); migrations run before the api starts; secrets via environment or files, never baked in.
- [ ] Health and readiness checks; `/metrics` (queue depth, run durations, failure rates, GitHub rate-limit remaining); structured logs; alert suggestions (queue stuck, failure spike, webhook failures).
- [ ] Backup and restore runbook for PostgreSQL (tested restore); Redis loss recovery runbook (re-queue from the database); upgrade and rollback runbook.
- [ ] GitHub App production setup guide and environment variable reference.

## Testing

- Isolation, canary, injection and CSRF suites as above, running in CI.
- Chaos checks: stop Redis, stop PostgreSQL, kill the worker; runs recover without duplicates.
- Restore a backup into a clean environment and verify the dashboard.
- Load test for webhook bursts (for example 200 PR events in a minute) with correct queueing and no dropped runs.

## Deliverables

- Security test suite, `docs/privacy.md`, `docs/operations.md`, production Compose, metrics and runbooks.

## Exit criteria

- AC-9, AC-17, AC-18, AC-20, AC-22, AC-23 pass; no high or critical dependency vulnerabilities; restore and recovery runbooks verified.

## Risks

- Prompt-injection defences are never absolute; layered validation and a no-tools design limit the blast radius.
- Operating a hosted service has a long tail (support, abuse, incidents); document an owner and an escalation path before opening it to outsiders.
