# Phase 10 – Validation, Pilot & Release

**Depends on:** Phases 0–9  
**Milestone:** M4 – v1  
**PRD refs:** §13 (success metrics), §15 (acceptance criteria), NFR Performance, NFR Cost control

## Goal

Prove the MVP meets its acceptance criteria and success metrics on fixtures and real repositories, then ship `v1` with documentation.

## Scope

In: acceptance test suite, performance and cost checks, pilot, tuning, documentation, release.  
Out: post-MVP features (patch generation, dashboards, other languages).

## Tasks

### Acceptance suite

- [ ] Build a fixture PR suite covering every acceptance criterion AC-1 to AC-12 and run it in CI against the mock provider.
- [ ] Maintain a small set of recorded real-provider runs for regression comparison of prompt changes.

| AC  | Check                                                                       |
| --- | --------------------------------------------------------------------------- |
| 1   | Triggers exactly once per configured event                                  |
| 2   | One structured summary with code, test and security status                  |
| 3   | High-confidence issue becomes an inline review comment                      |
| 4   | Low-confidence or informational findings do not create inline comments      |
| 5   | Missing tests labelled as suggestions when no report exists                 |
| 6   | LCOV coverage reported                                                      |
| 7   | Critical security fixture appears in summary and Check Run                  |
| 8   | Invalid output, timeout or single-agent failure gives a safe partial result |
| 9   | Fork PRs get no secrets or write token                                      |
| 10  | Same-SHA rerun adds no duplicates                                           |
| 11  | Ignored, generated and lock files excluded and reported                     |
| 12  | `fail_on_threshold` fails only at the configured threshold                  |

### Performance and cost

- [ ] Run a PR at the configured limits (40 files, 120k patch characters) and confirm a median under 5 minutes.
- [ ] Record token usage per PR size class; document expected cost ranges.
- [ ] Verify the request, token and concurrency caps actually stop runaway usage.

### Pilot

- [ ] Select 1–3 repositories (JS/TS) and install the Action in `comment_only` mode.
- [ ] Collect feedback per inline finding: useful, not useful, incorrect (for example reactions or a simple form).
- [ ] Run for a fixed period (suggested 2–4 weeks) or a fixed number of PRs.
- [ ] Log false positives, duplicates and missed obvious issues.

### Tuning

- [ ] Adjust prompts, confidence and severity thresholds, and Final Review usage from pilot data.
- [ ] Re-run the acceptance suite after every prompt or threshold change.

### Metrics (PRD §13)

| Metric                   | Target                          | Measured |
| ------------------------ | ------------------------------- | -------- |
| Workflow completion rate | ≥ 95% of eligible PR runs       | ☐        |
| Median review duration   | < 5 min                         | ☐        |
| Actionable finding rate  | ≥ 70% of posted inline findings | ☐        |
| False-positive rate      | < 20% of posted inline findings | ☐        |
| Duplicate-comment rate   | < 2% of runs                    | ☐        |
| Summary coverage         | ≥ 90% of eligible PRs           | ☐        |

### Documentation

- [ ] README: what it does, quick start, example workflow.
- [ ] Installation guide: secrets, permissions, config file.
- [ ] Configuration reference: every key, default and example.
- [ ] Enforcement and required-check guidance.
- [ ] Fork PR behaviour, security and privacy docs (from Phase 9).
- [ ] Troubleshooting: missing permissions, missing API key, oversized PRs, partial results.
- [ ] Cost notes and tuning guidance.

### Release

- [ ] Final `dist/` build, changelog, version tag `v1.0.0` and floating `v1` tag.
- [ ] Release notes listing known limitations and the deferred roadmap (PRD §14).
- [ ] Capture feedback process for post-MVP backlog.

## Deliverables

- Passing acceptance suite in CI.
- Pilot report with measured metrics.
- Documentation set and a tagged `v1` release.

## Exit criteria

- All AC-1 to AC-12 pass.
- Pilot metrics meet the targets, or the owner has approved documented exceptions.
- Documentation reviewed by someone who did not write the code and can install the Action from it alone.

## Risks

- Small pilot sample gives noisy metrics; report counts alongside percentages and extend the pilot if the sample is too small.
- Metric gaming through suppression: a low false-positive rate is only meaningful alongside a reasonable number of true findings; track missed issues as well.
