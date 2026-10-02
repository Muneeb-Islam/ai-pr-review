# Phase 16 – Validation, Pilot & Release

**Depends on:** Phases 0–15  
**Milestone:** M5 – v1  
**Refs:** scope §7, §8; PRD §13, §15

## Goal

Prove the platform meets its acceptance criteria and success metrics on fixtures and real repositories, then ship `v1` with documentation.

## Tasks

### Acceptance suite
- [ ] Automated tests mapping to every criterion AC-1–AC-23 (mock provider; real GitHub only where needed) running in CI; see the traceability table in `PHASES.md`.
- [ ] Recorded real-provider runs kept as regression fixtures for prompt changes.
- [ ] End-to-end test on the sandbox repo: install App → PR → pending → review → dashboard history → feedback → re-run.

### Performance and cost
- [ ] PR at the configured limits (40 files, 120k patch characters) completes with median under 5 minutes.
- [ ] Platform targets: webhook → `queued` p95 < 3 s; `queued` → `running` p95 < 30 s at normal load; dashboard updates < 5 s; API reads p95 < 500 ms.
- [ ] Record token use per PR size class and document expected cost ranges per provider.
- [ ] Verify request, token, concurrency and quota limits actually stop runaway usage.

### Pilot
- [ ] Install on 1–3 real JS/TS repositories in `comment_only` mode, with owners' consent and their own provider keys.
- [ ] Run for a fixed period (suggested 2–4 weeks) or number of PRs; collect feedback through the dashboard.
- [ ] Log false positives, duplicates and missed obvious issues; compare the dashboard metrics with manual spot checks.

### Tuning
- [ ] Adjust prompts, thresholds and Final Review usage from pilot data; re-run the acceptance suite after each change.

### Metrics

| Metric | Target | Measured |
|---|---|---|
| Workflow completion rate | ≥ 95% | ☐ |
| Median review duration | < 5 min | ☐ |
| Actionable finding rate | ≥ 70% | ☐ |
| False-positive rate | < 20% | ☐ |
| Duplicate-comment rate | < 2% | ☐ |
| Summary coverage | ≥ 90% | ☐ |

Report counts with percentages; extend the pilot if samples are too small.

### Documentation
- [ ] README with product overview, screenshots and quick start.
- [ ] User guide: install the App, sign in, add a provider key, configure a repo, read a review, give feedback.
- [ ] Admin guide: configuration reference, enforcement and required checks, fork policy, coverage artifact setup, troubleshooting (missing permissions, missing key, oversized PRs, partial runs).
- [ ] Self-hosting guide: Docker Compose, environment variables, GitHub App setup, backups, upgrades, scaling notes.
- [ ] Security, privacy and cost notes (from Phase 15).

### Release
- [ ] Version `v1.0.0`, changelog, container images tagged, migrations tested from the previous schema.
- [ ] Release notes with known limitations and the deferred roadmap (billing, other Git hosts, auto-fix, deeper language support, GitHub Enterprise).
- [ ] Support and feedback channel; post-v1 backlog from pilot findings.

## Deliverables

- Passing acceptance suite in CI, pilot report with measured metrics, documentation set, tagged `v1`.

## Exit criteria

- AC-1–AC-23 pass.
- Pilot metrics meet targets or have owner-approved, documented exceptions.
- Someone other than the author can self-host from the docs alone.

## Risks

- Small pilot gives noisy metrics; show counts and extend the pilot.
- Low false-positive rate achieved by over-suppression; track missed issues too.
