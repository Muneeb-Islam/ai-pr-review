# Phase 6 – Test Coverage Agent

**Depends on:** Phases 2 (test discovery), 4, 5  
**Unblocks:** Phase 8  
**PRD refs:** FR-22–FR-25, §8.3, AC-5, AC-6

## Goal

Assess how well the changed code is tested, report real changed-line coverage when a report exists, and otherwise give clearly labelled test-gap suggestions.

## Scope

In: LCOV ingestion, coverage calculation, test-gap analysis, test suggestions, summary integration.  
Out: running tests, JUnit and Codecov ingestion (deferred).

## Tasks

### LCOV ingestion (FR-22)

- [ ] Locate the report at `coverage.lcov_path` (default `coverage/lcov.info`).
- [ ] Parse LCOV records: source file, line hits (`DA`), functions (`FN`/`FNDA`), branches if present.
- [ ] Normalise file paths so they match repository-relative PR paths (handle absolute paths and Windows separators).
- [ ] Compute changed-file coverage and changed-line coverage by intersecting covered lines with the PR diff's added or modified lines.
- [ ] Handle partial availability: some changed files absent from the report are listed as "not in report".

### No-report fallback (FR-23)

- [ ] When no artefact exists, set `coverage.status = "not_available"` and state plainly that coverage could not be measured.
- [ ] Continue with code-based test-gap analysis.

### Test-gap analysis

- [ ] Use Phase 2 test discovery to map each changed source file or function to existing tests.
- [ ] Give the agent the changed code, the related existing tests and, if available, coverage data.
- [ ] Identify untested paths: new branches, error handling, boundary values, changed return contracts.

### Test suggestions (FR-24)

- [ ] Each suggestion includes: scenario, inputs or setup, expected assertion, target file and function where identifiable.
- [ ] Populate `Finding.suggestedTest` and use category `test_gap`.
- [ ] Prefer a few concrete suggestions over a long generic list.

### Wording and classification (FR-25)

- [ ] Separate two kinds of output: **"Suggested missing test"** (analysis-based) and **"Verified coverage deficiency"** (measured from the report).
- [ ] Never describe an analysis-based gap as measured coverage.

### Integration

- [ ] Register the agent with the orchestrator, controlled by `agents.test_coverage`.
- [ ] Fill `ReviewResult.coverage` (`status`, `changedLineCoverage`, `observations`).
- [ ] Add the coverage and test-suggestion sections to the summary.
- [ ] Test suggestions go to the summary; only attach inline comments when tied to a specific changed line at high confidence.

## Suggested layout

```
src/coverage/
  lcov.ts            # parser
  changedLines.ts    # intersection with diff
src/agents/testCoverage/
  agent.ts
  prompt.md
```

## Testing

- LCOV parser against real Jest and Vitest output, including empty and malformed files.
- Changed-line coverage calculation on hand-computed fixtures.
- Path normalisation cases.
- Fixture PR with no report: suggestions appear and are labelled as suggestions (AC-5).
- Fixture PR with LCOV: coverage percentage reported (AC-6).

## Deliverables

- Test Coverage agent, LCOV module and summary sections.

## Exit criteria

- AC-5 and AC-6 pass.
- Summary clearly distinguishes measured coverage from suggestions.

## Risks

- Path mismatches between LCOV and the diff silently produce 0% coverage; log unmatched files and report them rather than guessing.
- Coverage artefact may not exist at review time if tests run in a separate job; document that the report must be produced before the review step.
