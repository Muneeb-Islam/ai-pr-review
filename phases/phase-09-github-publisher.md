# Phase 9 – GitHub Publisher (M1: First End-to-End Slice)

**Depends on:** Phase 8  
**Unblocks:** Phases 10, 11, 12, 13  
**Milestone:** M1  
**Refs:** FR-17, FR-18, FR-20, FR-21, FR-29–FR-33, FR-38, AC-1–AC-4, AC-16

## Goal

Findings appear on a real PR as inline review comments, one summary comment and a Check Run that moves from queued to complete, and everything posted is recorded in the database.

## Tasks

### Check Run lifecycle (FR-30, AC-16)
- [ ] `AI PR Review` Check Run: `queued` at run creation (Phase 3), `in_progress` when the worker starts, `completed` with conclusion `success`, `neutral` or `failure` and a title and summary at the end. Store `check_run_id` on the run.
- [ ] This phase: `success` when completed, `neutral` when partial, skipped or failed. Enforcement-driven `failure` arrives in Phase 13.
- [ ] Skipped runs complete the check as `neutral` with the reason.

### Inline review (FR-17, FR-18, FR-33)
- [ ] Post inline comments in **one** Pull Request Review with event `COMMENT`; never approve or request changes.
- [ ] Re-validate each comment's path and line against the diff for the reviewed head SHA immediately before posting; drop any that fail and count them as suppressed.
- [ ] Default threshold: confidence ≥ 0.80 and severity ≥ `medium`, capped by `max_inline_comments`. Lower items go to the summary only.
- [ ] Embed the fingerprint marker in each comment (design §12) and record each in `posted_comments`.

### Summary comment (FR-20, FR-21, FR-31, FR-32)
- [ ] One comment with the hidden summary marker; create it the first time and update it in place afterwards.
- [ ] Content: status, counts by severity (critical → info), coverage and security placeholders (filled by Phases 11–12), test suggestions, skipped files with reasons, execution warnings, and a link to the run in the dashboard. Each finding labelled with its source agent.
- [ ] Draft PRs get the summary only (FR-05).
- [ ] Short sections, `<details>` for long lists, readable in dark mode and on mobile.

### Safety (FR-29, FR-38)
- [ ] Redaction pass on every outgoing body: no credentials, exploit payloads or large code excerpts.
- [ ] Only create or edit comments carrying our markers and authored by the App; never touch human comments.
- [ ] Handle 403 (missing permission) and 422 (invalid position) without failing the run; add a warning and continue.

### Wiring
- [ ] Worker calls the publisher after persistence; publisher results (comment IDs) are stored; run status reflects publishing errors as warnings, not silent success.
- [ ] A dashboard deep link is built from `PUBLIC_URL` and the run ID.

## Testing

- Octokit mocked: review payload, summary create vs update, check run transitions.
- Summary snapshots: no findings, mixed severities, partial, skipped.
- Invalid or stale line is not posted; redaction removes planted secrets.
- Manual end-to-end on the sandbox: seeded-bug PR gets inline comment, summary and Check Run, and the run row has `posted_comments`.

## Deliverables

- Publisher module and a working end-to-end flow from PR event to GitHub output and stored history.

## Exit criteria

- AC-1, AC-2 (code-review portion), AC-3, AC-4 and AC-16 pass on the sandbox repo.
- M1 demo: open a PR, see queued → in progress → completed Check Run and the posted review, and find the run in the database.

## Risks

- A bad diff position can reject the whole review with a 422. Validate each comment and fall back to summary-only for the rest.
- Missing App permissions on installations; detect 403 early and surface it in the dashboard.
