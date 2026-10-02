# Phase 13 – Lifecycle, Enforcement & Resilience

**Depends on:** Phases 9, 11, 12  
**Unblocks:** Phases 14, 15  
**Refs:** FR-34–FR-38, FR-14, AC-8, AC-10, AC-12, AC-15, AC-21, design §12–§14

## Goal

Reruns are clean and idempotent, enforcement is configurable, and partial failure degrades gracefully instead of producing noise or crashes.

## Tasks

### Head SHA and stale positions (FR-35, AC-15)
- [ ] Re-read the PR head before publishing; if it changed, publish nothing inline, mark the run `superseded` and let the newer run speak.
- [ ] Verify end to end that a push during a run stops further model calls and posts nothing stale.

### Idempotency (FR-36, AC-10)
- [ ] Stable fingerprints (design §12) stored in `findings` and `posted_comments`; the same fingerprint for the same head SHA is never posted twice, checked against both the database and the markers on GitHub (covers a lost database write).
- [ ] The summary comment is updated in place; a rerun on the same SHA creates a new run row (history) but no duplicate GitHub comments.

### Previous-finding tracking (FR-37)
- [ ] Compare findings from the previous run on the PR (from the database) with the new run: **resolved**, **still applicable**, **no longer evaluated**; show in the summary and run detail.
- [ ] Never resolve or delete human review threads (FR-38).

### Re-run (AC-21)
- [ ] `POST /api/runs/:id/rerun` (admin, audited) creates a new `queued` run linked by `parent_run_id` for the PR's current head; `/ai-review` comments and the Check Run "Re-run" button use the same path.
- [ ] `POST /api/runs/:id/cancel` stops a queued or running run (audited).

### Enforcement modes (FR-34, AC-12)
- [ ] `comment_only` (default), `warn`, `fail_on_threshold` per design §14; `failure` only when a finding meets both thresholds.
- [ ] Document that `failure` blocks merges only if the repo requires the check.

### Partial results (FR-14, AC-8)
- [ ] Per-agent timeout, malformed output and provider failure produce `partial` with non-sensitive warnings; the Check Run ends `neutral`.
- [ ] If every agent fails: `failed`, summary explains, Check Run `neutral` unless config says otherwise.

### Final Review agent (optional)
- [ ] `agents.final_review`: second pass that checks each proposed finding against the diff and rejects unsupported ones; record approved and rejected counts and the `rejected_by_final_review` suppress reason; measure its effect in the pilot.

### Observability
- [ ] Structured log per agent (status, duration, request size, retries) and suppressed counts by reason; usage estimates in logs and the database only, never in PR comments.

## Testing

- Same SHA twice: no duplicate comments, summary updated in place (AC-10).
- New commit mid-run: superseded, nothing stale posted (AC-15).
- Enforcement matrix: each mode × (no findings, low finding, high finding above and below the confidence threshold) (AC-12).
- Simulated provider timeout, malformed output and single-agent failure give `partial`, not a crash (AC-8).
- Re-run creates a linked run (AC-21).
- Lost database write after posting: next run does not re-post (marker check).

## Deliverables

- Idempotent, policy-driven publish pipeline, re-run and cancel, previous-finding tracking and the optional Final Review agent.

## Exit criteria

- AC-8, AC-10, AC-12, AC-15, AC-21 pass.

## Risks

- Fingerprints too specific cause duplicates after small edits; too loose hide new findings. Tune on fixture sequences of successive commits.
- Final Review adds cost and latency; keep it optional.
