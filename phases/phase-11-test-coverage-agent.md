# Phase 11 – Test Coverage Agent

**Depends on:** Phases 5 (test discovery), 7, 9  
**Unblocks:** Phase 13  
**Refs:** FR-22–FR-25, AC-5, AC-6, decision 19

## Goal

Assess how well the changed code is tested. Report real changed-line coverage when CI has uploaded a coverage artifact; otherwise give clearly labelled test-gap suggestions.

## Tasks

### Coverage from GitHub Actions artifacts (FR-22)
- [ ] Find the workflow runs for the PR's head SHA through the Actions API (`actions: read`), list their artifacts, and pick the one named `coverage.artifact_name` (default `coverage`).
- [ ] Download and unzip the artifact in memory with size limits (zip-bomb safe: cap compressed and uncompressed size and file count); read `coverage.lcov_path` (default `lcov.info`). Never write it to disk unencrypted beyond a temp directory that is cleaned up.
- [ ] Parse LCOV: files, line hits (`DA`), functions (`FN`/`FNDA`), branches if present.
- [ ] Normalise paths so they match repository-relative PR paths (absolute paths, Windows separators, monorepo prefixes).
- [ ] Compute changed-file and changed-line coverage by intersecting covered lines with the PR's added lines; list changed files missing from the report as "not in report".

### No-report fallback (FR-23)
- [ ] If CI is still running, the artifact is missing or the App lacks `actions: read`: `coverage.status = "not_available"`, say plainly that coverage could not be measured and why, and continue with code-based analysis.
- [ ] Stretch: handle `workflow_run` completed to re-evaluate coverage and update the summary once CI finishes.

### Test-gap analysis and suggestions (FR-24, FR-25)
- [ ] Use Phase 5 test discovery to map changed code to existing tests; give the agent the changed code, related tests and coverage data when present.
- [ ] Identify untested paths: new branches, error handling, boundaries, changed return contracts.
- [ ] Each suggestion has scenario, inputs or setup, expected assertion and target file/function; stored in `suggested_test` with category `test_gap`.
- [ ] Clearly separate **"Suggested missing test"** (analysis) from **"Verified coverage deficiency"** (measured). Never present an analysis-based gap as measured coverage.

### Integration
- [ ] Register the agent (`agents.test_coverage`); fill the result's coverage section, the summary coverage block and the run detail in the dashboard (coverage status and percentage).
- [ ] Suggestions go to the summary; inline only when tied to a specific changed line at high confidence.

## Testing

- LCOV parser against real Jest and Vitest output, empty and malformed files.
- Changed-line coverage calculation on hand-computed fixtures; path normalisation cases.
- Artifact handling: missing artifact, oversized artifact, malicious zip, permission error.
- Fixture PR without a report: suggestions labelled as suggestions (AC-5). Fixture PR with an artifact: coverage reported (AC-6).

## Deliverables

- Test Coverage agent, artifact reader, LCOV module, summary and dashboard coverage sections, and a README note telling users to upload coverage from CI.

## Exit criteria

- AC-5 and AC-6 pass; summary distinguishes measured coverage from suggestions.

## Risks

- Coverage may not exist yet when the review runs. Report that clearly; offer the `workflow_run` re-evaluation as a follow-up.
- Path mismatches produce a false 0%; log and report unmatched files instead of guessing.
