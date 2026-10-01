# Phase 8 – PR Lifecycle, Enforcement & Resilience

**Depends on:** Phases 5, 6, 7  
**Unblocks:** Phases 9, 10  
**PRD refs:** FR-34–FR-38, FR-14, §8.3 (Final Review Agent), NFR Reliability, NFR Observability, AC-8, AC-10, AC-12

## Goal

Make reruns clean and idempotent, make enforcement configurable, and make partial failures degrade gracefully instead of crashing or producing noise.

## Scope

In: head-SHA handling, idempotency, previous-finding tracking, enforcement modes, partial-result handling, optional Final Review agent, observability.  
Out: fork-specific safety (Phase 9).

## Tasks

### Head SHA and stale positions (FR-35)

- [ ] Tag every result with the head SHA it reviewed.
- [ ] Before posting, re-fetch the PR head; if it changed during the run, skip inline comments for the stale SHA and note it in the summary.

### Idempotency (FR-36, AC-10)

- [ ] Generate a stable fingerprint per finding (file, normalised line range, category, normalised title).
- [ ] Embed the fingerprint in a hidden marker in each inline comment.
- [ ] On rerun, read the Action's existing comments and skip findings already posted for the same SHA.
- [ ] Update the summary comment in place (found via its hidden marker) rather than creating a new one (FR-31).

### Previous-finding tracking (FR-37)

- [ ] Compare earlier findings with the new run and label each as **resolved**, **still applicable** or **no longer evaluated**.
- [ ] Show this in the summary.
- [ ] Do not resolve or delete human review threads (FR-38).

### Enforcement modes (FR-34, AC-12)

- [ ] `comment_only` (default): Check Run conclusion is `success`, or `neutral` if partial.
- [ ] `warn`: Check Run is `neutral` when any finding meets the threshold.
- [ ] `fail_on_threshold`: Check Run is `failure` only when at least one finding meets both the configured severity and confidence threshold.
- [ ] Document that `failure` only blocks merging if the repository marks the check as required.

### Partial results and error handling (FR-14, AC-8)

- [ ] Per-agent timeout, malformed output and provider failure produce `status: "partial"` with a clear, non-sensitive warning.
- [ ] Workflow ends `neutral`, not failed, when partial analysis exists.
- [ ] If every agent fails, publish a summary explaining the review could not run and set the status to `failed` or `neutral` per config.
- [ ] Top-level try/catch so an unhandled exception still attempts to update the Check Run.

### Final Review Agent (optional, §8.3)

- [ ] Config flag `agents.final_review`.
- [ ] Second-pass agent that checks each proposed finding against the diff and rejects unsupported ones.
- [ ] Record approved and rejected counts.

### Observability

- [ ] Structured log per agent: status, duration, request size, retry count.
- [ ] Log suppressed-finding counts by reason (threshold, duplicate, invalid line, style-only).
- [ ] Log estimated model usage to the workflow log only.

## Suggested layout

```
src/lifecycle/
  fingerprint.ts
  previousFindings.ts
  staleHead.ts
src/policy/
  enforcement.ts
src/agents/finalReview/
  agent.ts
  prompt.md
```

## Testing

- Run the same head SHA twice: no new inline comments, summary updated in place (AC-10).
- Push a new commit: findings re-evaluated; resolved items labelled correctly.
- Enforcement matrix: each mode × (no findings, low finding, high finding at confidence below and above threshold) (AC-12).
- Simulated provider timeout, malformed output and single-agent failure give partial and neutral, not a crash (AC-8).
- Head changes mid-run: no stale inline comments.

## Deliverables

- Idempotent, policy-driven publish pipeline with an optional Final Review agent.

## Exit criteria

- AC-8, AC-10 and AC-12 pass.
- Rerun on the same SHA creates no new comments.

## Risks

- Fingerprints too specific cause duplicates after small edits; too loose hide real new findings. Tune against fixture sequences of successive commits.
- Final Review adds cost and latency; keep it optional and measure its effect on the false-positive rate in the pilot.
