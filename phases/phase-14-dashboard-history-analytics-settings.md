# Phase 14 – Dashboard: History, Analytics & Settings

**Depends on:** Phases 10, 13  
**Unblocks:** Phase 16  
**Milestone:** M4  
**Refs:** UI-05–UI-08, UI-10, PL-08, PL-15, AC-19, AC-20, AC-21

## Goal

Complete the dashboard: browse full history, give feedback on findings, manage repository settings and credentials, and see the success metrics.

## Tasks

### History and findings explorer (UI-05)
- [ ] Findings list across runs with filters: repo, severity, category, agent, status (posted or suppressed), date, file path search; cursor pagination.
- [ ] Per-PR history view: all runs for a PR in order, with finding changes between runs (resolved, still applicable, new).
- [ ] Finding detail: evidence excerpt, impact, recommendation, suggested test, link to the exact GitHub comment or file line.
- [ ] **Feedback:** useful / false positive / already known, with an optional note; one vote per user per finding (`POST /api/findings/:id/feedback`); optional stretch: read 👍/👎 reactions on the inline comment.

### Settings (UI-06)
- [ ] Repository settings page: enable/disable, agents, thresholds, enforcement mode, target branches, ignore patterns, secret paths, fork policy, draft behaviour, custom instructions, size limits.
- [ ] Keys coming from the repo file are shown as read-only with a "set by `.github/ai-pr-review.yml`" label (from the effective-config endpoint).
- [ ] Provider and model selection with a clear privacy notice per provider (including the DeepSeek notice); credential entry is write-only, shows last four characters, supports replace and delete, and has a "test connection" button.
- [ ] Form validation mirrors the shared zod schema; unsaved-change warning; admin-only controls disabled for viewers with an explanation.
- [ ] Installation-level defaults page; read-only quota usage (runs and tokens today).

### Actions (UI-08)
- [ ] Re-run and cancel buttons with confirmation; results appear live; entries visible in an audit view for admins.

### Analytics (UI-07)
- [ ] Summary tiles for the selected repo and range: reviews, completion rate, median duration, findings by severity, actionable rate and false-positive rate (from feedback), duplicate rate, summary coverage.
- [ ] Charts: reviews over time, severity mix, duration trend, failures and partials by cause, token usage and estimated cost.
- [ ] Each tile shows the PRD §13 target and whether it is met, plus the sample size so small samples are not over-read.
- [ ] Backend: `/api/analytics/summary` and `/timeseries`, computed with indexed SQL queries, tenant-scoped.

### Data lifecycle (PL-08, AC-20)
- [ ] Retention setting shown in the UI; scheduled cleanup job implemented (also verified in Phase 15); runs older than the window disappear from history.
- [ ] Export runs or findings as CSV (admin).

### Quality (UI-10)
- [ ] Empty, loading and error states everywhere; responsive layouts; keyboard and screen-reader pass; dark-mode contrast check.

## Testing

- Component and integration tests for filters, feedback, settings forms and validation.
- Feedback changes analytics values (AC-19).
- Permission tests: viewers cannot edit settings or credentials; the UI and the API both enforce it.
- Playwright: edit a setting, change the key, re-run a PR, give feedback, view analytics on seeded data.
- Analytics queries verified against hand-computed seed data.

## Deliverables

- History, findings explorer, feedback, settings, credential management, analytics and audit views.

## Exit criteria

- AC-19, AC-20 (history/filter part) and AC-21 pass through the UI.
- An admin can configure a repo from scratch (key, model, agents) without touching YAML.

## Risks

- Analytics on small samples can mislead; always show counts.
- Settings UI and the repo file can disagree; make precedence visible.
