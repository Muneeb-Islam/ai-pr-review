# Phase 5 – GitHub Publisher (First End-to-End Slice)

**Depends on:** Phase 4  
**Unblocks:** Phases 6, 7, 8  
**Milestone:** M1 – vertical slice  
**PRD refs:** FR-17, FR-18, FR-20, FR-21, FR-29–FR-33, FR-38, NFR Accessibility, AC-1–AC-4

## Goal

Findings from the Code Review agent appear on a real pull request as inline review comments, one summary comment and a Check Run.

## Scope

In: inline review, summary comment, Check Run, redaction, Markdown formatting.  
Out: rerun idempotency and previous-finding tracking (Phase 8), enforcement modes beyond the basic conclusion (Phase 8).

## Tasks

### Inline review comments (FR-17, FR-18, FR-33)

- [ ] Publish inline comments together as one GitHub Pull Request Review (`pulls.createReview`), not as issue comments.
- [ ] Re-validate every comment's path and line against the diff for the reviewed head SHA immediately before posting; drop any that fail.
- [ ] Default threshold: confidence ≥ 0.80 and severity ≥ `medium`. Lower items go only to the summary.
- [ ] Review event type `COMMENT` (never `APPROVE` or `REQUEST_CHANGES` in MVP).

### Summary comment (FR-20, FR-21, FR-31, FR-32)

- [ ] One comment containing a hidden marker (for example `<!-- ai-pr-review:summary -->`) so it can be found and updated later.
- [ ] Content: review status, finding counts grouped by critical / high / medium / low / info, coverage status, security status, test suggestions, skipped files with reasons, execution warnings, workflow run link.
- [ ] Each finding labelled with its source agent and a concise human-readable explanation.
- [ ] Leave placeholders for the coverage and security sections until Phases 6 and 7 fill them.

### Check Run (FR-30)

- [ ] Create a Check Run named `AI PR Review` with a title, summary and conclusion of `success`, `neutral` or `failure`.
- [ ] For this phase: `success` when completed, `neutral` when partial or skipped. Enforcement-driven `failure` arrives in Phase 8.

### Safety and formatting

- [ ] Redaction pass over every outgoing comment: no credentials, exploit payloads or large code excerpts (FR-29).
- [ ] Use GitHub-flavoured Markdown that reads well in dark mode and on mobile: short sections, no wide tables, `<details>` for long lists.
- [ ] Only create the Action's own comments; never edit or delete comments it did not create (FR-38).
- [ ] Handle API errors (403 for missing permissions, 422 for invalid position) without crashing; surface a clear warning.

### Draft PRs

- [ ] When the PR is a draft and the default applies, post the summary only (FR-05).

## Suggested layout

```
src/publisher/
  review.ts          # inline review
  summary.ts         # summary body builder
  checkRun.ts
  markdown.ts        # formatting helpers
  redact.ts
  index.ts           # publish(result)
```

## Testing

- Octokit mocked: correct payload for review, summary and Check Run.
- Summary snapshot tests for each state: no findings, mixed severities, partial, skipped.
- A finding with a stale or invalid line is not posted.
- Redaction removes injected fake secrets from comment bodies.
- Manual end-to-end run on a sandbox repo with a seeded-bug PR.

## Deliverables

- A sandbox PR showing inline comments, one summary and an `AI PR Review` check.

## Exit criteria

- AC-1, AC-2, AC-3 and AC-4 pass on the sandbox repo.
- Publisher unit tests with GitHub API mocks pass.

## Risks

- Incorrect diff position causes a 422 that rejects the whole review; validate each comment and fall back to summary-only for the rest.
- Missing token permissions; document required permissions and detect 403 early.
