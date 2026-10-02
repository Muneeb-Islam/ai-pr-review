# Phase 3 – GitHub App & Webhooks

**Depends on:** Phase 2  
**Unblocks:** Phases 4, 8, 9  
**Refs:** PL-01–PL-04, PL-06, FR-01, FR-02, FR-05, AC-1, AC-9, AC-13–AC-16, AC-22, design §4, §7

## Goal

GitHub events reach the api safely and create the right database records: a `queued` run for eligible PRs, a `skipped` run (with reason) for guarded ones, and installation state kept in sync.

## Tasks

### GitHub App setup
- [x] Document and script App registration (app manifest) for a development App: permissions and events from design §4, webhook URL, callback URL.
- [ ] Create a sandbox repository and install the development App on it (closes decision 8). Record the setup steps in `docs/github-app-setup.md`.
- [x] App authentication in `packages/core/github`: App JWT, installation token creation and in-memory caching with early refresh; Octokit factory per installation.
- [x] Local development: webhook forwarding (smee or a tunnel) documented; a **replay script** `scripts/replay-webhook` sends a saved payload with a valid signature (replaces `local-run.mjs`).

### Webhook endpoint
- [x] `POST /webhooks/github` with raw-body access; verify `X-Hub-Signature-256` with constant-time comparison; reject missing or invalid signatures with 401 and create nothing (AC-13).
- [x] Payload size limit; unknown events acknowledged and ignored.
- [x] Record `X-GitHub-Delivery` in `webhook_deliveries`; a repeated delivery ID is a no-op (AC-14). Store event, installation and outcome.
- [x] Respond `202` immediately after recording; do processing in-process asynchronously or via the queue interface (final queue arrives in Phase 8). Handlers are idempotent.

### Installation sync (PL-01, AC-22)
- [x] `installation` created / deleted / suspend / unsuspend: create, deactivate or reactivate the installation and its repositories.
- [x] `installation_repositories` added / removed: add or deactivate repositories.
- [x] Deactivated installations create no new runs.

### Pull request events
- [x] `pull_request` `opened`, `reopened`, `synchronize`, `ready_for_review`: build the PR info and apply `decide()` from `packages/core/routing` using the effective config (dashboard settings plus defaults for now; repo-file merge arrives in Phase 5).
- [x] Guards: repo enabled, target branch, draft behaviour, fork policy (`skip` by default, `review` if admin opted in), per-installation quota hook (full quotas in Phase 8).
- [x] Guard says skip → create a `skipped` run with `status_reason`. Eligible → **supersede** older `queued` runs for the same PR and mark `running` ones for cancellation (PL-06), create a `queued` run, and call `enqueue(runId)` through a `JobQueue` interface (no-op or in-memory implementation until Phase 8).
- [x] `issue_comment` with `/ai-review` on a PR: only for `OWNER`, `MEMBER` or `COLLABORATOR`; creates a manual run for the PR's current head. Others are ignored.
- [x] `check_run` `rerequested` for our check: create a re-run linked via `parent_run_id`.
- [x] Create the Check Run in `queued` state at run creation so the PR shows pending quickly (AC-16). Publisher details come in Phase 9; here a minimal create call is enough.

## Status

Implemented and tested against a real PostgreSQL and a fake GitHub gateway; the real process was also driven end to end with the replay script. **Open, needs the owner:** create the sandbox repository and install a registered development App on it (the one unticked task above and the "Manual" test and last exit criterion below). The setup steps are in [docs/github-app-setup.md](../docs/github-app-setup.md).

Implementation decisions worth knowing:

- **Raw body first.** The webhook plugin keeps its own `application/json` parser that hands over the unparsed buffer; the signature is checked on those bytes and JSON is parsed only afterwards.
- **Record, answer 202, process in the background.** `WebhookService.receive` inserts the delivery (atomic, so redelivery is a no-op) and returns; the handler runs afterwards in the same process. A delivery whose processing failed is stored with outcome `error` and **is processed again** when GitHub redelivers it; a successful or ignored one is a no-op.
- **Supersede, not cancel.** A new eligible run moves older `queued` and `running` runs of the same PR to `superseded` in the same transaction (advisory lock per PR). The worker (Phase 8) must check its run's status between stages and stop when it is no longer `running`. Stale Check Runs on older commits are not touched until the publisher exists (Phase 9).
- **Same head, same trigger, still active = same run.** Such an event reuses the run and only re-enqueues, so `JobQueue.enqueue` must be idempotent per run id (BullMQ `jobId = runId`).
- **Self-healing.** A PR event for an installation or repository we have never seen creates it from the signed payload (the `installation` event may be missed or in flight). A suspended or deleted installation, or a repository removed from the installation, is never revived by a PR event.
- **Default branch.** `installation` events do not carry it; new repositories get `main` until a PR event delivers the real value.
- **Draft depth is not stored.** A draft PR under `summary_only` gets a normal `queued` run; the worker recomputes the depth from the PR and config (Phase 5/8). Only `draft_behavior: skip` creates a `skipped` run.
- **Re-run of an old commit is ignored** (`check_run` re-requested while the PR head moved on) so it cannot supersede the current review.
- **Quota hook.** `WebhookDeps.quota` is a function returning allowed or a reason; the default allows everything. Phase 8 supplies the real check.

## Testing

- Signature: valid, invalid, missing, body modified, wrong secret.
- Duplicate delivery processed once.
- Installation lifecycle events change installation and repo state correctly.
- Matrix of PR events × (wrong branch, draft, fork with `skip`, fork with `review`, repo disabled, inactive installation): correct run status and reason.
- New `synchronize` supersedes the older queued run.
- `/ai-review` from a collaborator creates a run; from a stranger does not.
- Manual: install on the sandbox repo, open a PR, see a run row and a queued Check Run.

## Deliverables

- Webhook endpoint, installation sync, PR event handling, App auth, replay script, setup doc.

## Exit criteria

- AC-13, AC-14, AC-22 pass; AC-16 passes for the queued Check Run; the supersede rule is covered by tests.
- A real PR event on the sandbox repo produces a `queued` run in the database.

## Risks

- Reading the body after JSON parsing breaks signatures; capture the raw body explicitly.
- Webhook bursts. Keep the handler short, do heavy work in the worker.
- Forks: the webhook exists for fork PRs, so the guard order matters; test it with real fork payload fixtures.
