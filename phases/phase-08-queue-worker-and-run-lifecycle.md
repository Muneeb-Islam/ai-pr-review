# Phase 8 – Queue, Worker & Run Lifecycle

**Depends on:** Phases 2, 3, 7 (and 4 for credentials)  
**Unblocks:** Phase 9  
**Refs:** PL-05–PL-07, PL-11, FR-16, AC-15, AC-23, design §7, §13

## Goal

Queued runs are picked up by a worker, executed by the review engine, and every step is persisted so the run history is complete, even before anything is posted to GitHub.

## Tasks

### Queue (PL-05)
- [ ] Implement the `JobQueue` interface from Phase 3 with BullMQ on Redis: `enqueue({ runId })`, retries with backoff for infrastructure errors only, dead-letter queue, job IDs equal to run IDs (no duplicate jobs).
- [ ] Replace the Phase 3 in-memory enqueue with the real queue in the api.

### Worker
- [ ] `apps/worker`: consume jobs; claim a run atomically (`queued` → `running`, set `started_at`); skip if the run is no longer `queued` (superseded or cancelled).
- [ ] Load run, repository, settings, effective config and the decrypted provider credential (worker-side only). Missing or invalid credential → run `failed` with a clear reason, no model call.
- [ ] Create the Octokit instance for the installation, then call `collectContext`, `runReview` and persist: agent runs (status, duration, tokens, retries, warnings), findings (including suppressed reasons), warnings, usage and skipped files.
- [ ] Final status: `completed`, `partial`, `failed` or `skipped` (size policy). Every state change writes the row and publishes `run.updated` to Redis for SSE.
- [ ] Publishing to GitHub is a stub here (Phase 9 fills it in).

### Supersede and cancel (PL-06, AC-15)
- [ ] Keep an `AbortController` per running run; subscribe to Redis messages (`run.cancel`) so cancel and supersede from the api stop in-flight work.
- [ ] The engine checks the signal between stages; superseded or cancelled runs persist a final state and publish nothing.
- [ ] When a newer run for the PR finishes setup, the worker re-checks run status before publishing.

### Fairness, limits and quotas (PL-05, PL-11, AC-23)
- [ ] Global worker concurrency and a per-installation concurrency cap.
- [ ] Per-installation daily quotas (runs and tokens) from configuration; exceeded → run created as `skipped` with reason `quota_exceeded` (checked at enqueue and again at start).
- [ ] Per-run limits from config (requests, tokens, timeout) passed into the provider layer.

### Reliability
- [ ] Worker heartbeat per running run; a sweeper requeues or fails runs whose heartbeat expired (stuck-run recovery).
- [ ] Idempotent handlers: re-processing a run never duplicates agent runs or findings (upsert by run + agent + fingerprint).
- [ ] Graceful shutdown: stop taking jobs, let the current run finish or mark it re-queueable.
- [ ] Top-level try/catch: unexpected errors mark the run `failed`, log without source content or keys.

## Testing

- Integration tests with real Redis and PostgreSQL and the mock provider: queued → running → completed; partial; failed; skipped.
- Superseded run stops early; no findings posted after supersede.
- Killing the worker mid-run: the sweeper recovers the run.
- Duplicate job delivery does not duplicate data.
- Quota exceeded creates a `skipped` run with the reason.
- Missing credential gives a clear failed run.

## Deliverables

- Working queue and worker producing a complete stored history for a webhook-created run.

## Exit criteria

- A PR event on the sandbox repo produces a persisted run with agent runs and findings, using a real provider key.
- AC-15 and AC-23 pass at the data level.

## Risks

- Lost or double-processed jobs. Mitigation: idempotent handlers, DB as the source of truth, requeue from the database.
- Long runs holding queue locks. Use lock renewal and heartbeat.
