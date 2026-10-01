# Implementation Phases

## Multi-Agent Coding & PR Review Assistant

Derived from `Multi-Agent-Coding-PR-Review-Assistant-PRD.md` (v0.1). Requirement IDs (`FR-xx`) and acceptance criteria (`AC-n`, PRD §15) are referenced so each phase traces back to the PRD.

## Overview

| Phase | Name                                                                                          | Outcome                                               | Maps to                   |
| ----- | --------------------------------------------------------------------------------------------- | ----------------------------------------------------- | ------------------------- |
| 0     | [Decisions & technical design](phases/phase-00-decisions-and-design.md)                       | Open questions closed, design doc agreed              | PRD §17, §18              |
| 1     | [Project foundation](phases/phase-01-project-foundation.md)                                   | Buildable TS Action, config loading, CI               | FR-01–05                  |
| 2     | [Context collection & policy engine](phases/phase-02-context-and-policy.md)                   | Safe, filtered, size-limited PR context               | FR-06–10                  |
| 3     | [AI provider layer](phases/phase-03-ai-provider-layer.md)                                     | DeepSeek, Anthropic + OpenAI behind one interface     | FR-15, FR-16              |
| 4     | [Agent framework & Code Review agent](phases/phase-04-agent-framework-and-code-review.md)     | First agent producing validated findings              | FR-11–14, FR-19           |
| 5     | [GitHub publisher (first end-to-end slice)](phases/phase-05-github-publisher.md)              | Inline review + summary + Check Run on a real PR      | FR-17, 18, 20, 21, 30–33  |
| 6     | [Test Coverage agent](phases/phase-06-test-coverage-agent.md)                                 | Test-gap analysis and LCOV coverage                   | FR-22–25                  |
| 7     | [Security agent](phases/phase-07-security-agent.md)                                           | Security findings surfaced in summary and Check Run   | FR-26–29                  |
| 8     | [PR lifecycle, enforcement & resilience](phases/phase-08-lifecycle-enforcement-resilience.md) | Idempotent reruns, enforcement modes, partial results | FR-34–38, NFR Reliability |
| 9     | [Security hardening & fork safety](phases/phase-09-security-hardening-and-fork-safety.md)     | Fork-safe, injection-resistant, least privilege       | PRD §10, AC-9             |
| 10    | [Validation, pilot & release](phases/phase-10-validation-pilot-release.md)                    | Metrics measured, `v1` tagged                         | PRD §13, §15              |

**Confirmed decisions (2026-10-01)** — full detail in [docs/decision-log.md](docs/decision-log.md), interfaces in [docs/design.md](docs/design.md):

- Public reusable Action, so fork safety applies from day one.
- Provider: DeepSeek primary (OpenAI-compatible), Anthropic and OpenAI also supported.
- Runs only on PRs targeting `main` or `master`.
- `comment_only` default; JS/TS only; LCOV only; AI-only security review.
- Sandbox repo to be created in Phase 1; repo/Action name deferred.

**Milestones**

- **M1 – Vertical slice (end of Phase 5):** a PR gets inline code-review comments, a summary, and a Check Run.
- **M2 – Feature complete (end of Phase 7):** all three agents running.
- **M3 – MVP release candidate (end of Phase 9):** all acceptance criteria satisfied on fixtures.
- **M4 – v1 (end of Phase 10):** pilot metrics met, documented, tagged.

The ordering builds a thin end-to-end slice first (Phases 1–5) and then adds agents, so GitHub output and the schema contract are proven before more agents depend on them.

---

## Phase 0 – Decisions & technical design

**Goal:** Close the seven open decisions (PRD §17) and produce the technical design the PRD §18 calls for.

**Tasks**

- Decisions confirmed (see [docs/decision-log.md](docs/decision-log.md)):

  | #   | Decision         | Answer                                                |
  | --- | ---------------- | ----------------------------------------------------- |
  | 1   | Distribution     | Public reusable Action                                |
  | 2   | Provider         | DeepSeek primary; Anthropic and OpenAI also supported |
  | 3   | Execution policy | PRs targeting `main`/`master` only                    |
  | 4   | Enforcement      | `comment_only` default                                |
  | 5   | Language scope   | Node.js/TypeScript only                               |
  | 6   | Coverage source  | LCOV (Jest/Vitest) only                               |
  | 7   | Security tooling | AI-only; scanner extension point                      |

- Write the technical design: event model, module interfaces, config schema, permission strategy, prompt templates, error taxonomy.
- Decide Action packaging: JavaScript Action bundled with `@vercel/ncc`/`esbuild`, with `dist/` committed (or a Docker/composite alternative).
- Decide how to handle model names: config-only, no hard-coded IDs (PRD §6).

**Deliverables:** `docs/design.md`, decision log, config JSON Schema draft. (`docs/design.md` and `docs/decision-log.md` are written; the config JSON Schema is produced in Phase 1.)

**Exit criteria:** Owner sign-off on decisions 1–7 and the design doc.

---

## Phase 1 – Project foundation

**Goal:** A buildable, testable TypeScript GitHub Action skeleton that loads config and authenticates.

**Tasks**

- Initialise repo: TypeScript (strict), ESLint, Prettier, Vitest/Jest, bundler, `action.yml`.
- Define core types from PRD §12: `Finding`, `ReviewResult`, `Severity`, `Category`.
- Config loader for `.github/ai-pr-review.yml` + Action inputs, validated with a schema (zod/ajv); sensible defaults; clear errors (FR-03, FR-04).
- Event router: handle `pull_request` (`opened`, `reopened`, `synchronize`, `ready_for_review`), `workflow_dispatch`, and optional `/ai-review` comment (FR-01, FR-02).
- Draft-PR behaviour switch: summary-only by default (FR-05).
- Target-branch guard: review only PRs whose base is in `review.target_branches` (default `main`, `master`).
- Fork-PR guard from the start: no provider call and no write call on forks (public repo).
- Create the sandbox GitHub repo used for end-to-end testing.
- GitHub client wrapper (Octokit) with rate-limit/retry handling.
- Structured logger (run ID, PR number, no source content or secrets) (NFR Observability).
- CI for this repo: lint, typecheck, test, build, `dist/` freshness check.
- Sample workflow and example config from PRD §11.

**Deliverables:** Working Action that runs on a test repo and logs parsed config and event type.

**Exit criteria:** Unit tests for config validation and event routing pass; Action runs in a sandbox repo.

---

## Phase 2 – Context collection & policy engine

**Goal:** Gather exactly the PR context needed, with unsafe or irrelevant content removed before any model sees it.

**Tasks**

- Context collector (FR-06): PR title/body, base/head SHAs, changed files, patches, changed line ranges, existing review comments, previous bot results.
- Diff parser: map patch hunks to valid new-file line numbers (needed later for FR-17).
- Selective surrounding-code fetch within size limits (FR-07).
- Exclusion rules (FR-08): binary, generated, lockfiles, vendored, configured `ignore` globs; record each skip with a reason for `skippedFiles`.
- Secret protection (FR-10): never include env values or tokens; exclude files matching secret patterns (`.env*`, keys, certs); redact secret-like strings in diffs.
- Size policy (FR-09): enforce `max_changed_files` and `max_patch_characters`; prioritise critical files; produce a "limited review"/"skipped" status with explanation.
- Token budgeting helpers (estimate size before sending).
- Test file discovery for JS/TS (`*.test.ts`, `*.spec.ts`, `__tests__/`) to feed Phase 6.

**Deliverables:** `collectContext()` returning a typed `ReviewContext` plus `skippedFiles`.

**Exit criteria:** Fixture-based unit tests: ignored/lock/generated/secret files never appear in context (AC-11); oversized PR yields a transparent limited/skipped result; diff line mapping verified against sample patches.

---

## Phase 3 – AI provider layer

**Goal:** A single typed interface over DeepSeek, Anthropic and OpenAI.

**Tasks**

- `Provider` interface: `complete(request) → structured response`, with timeout, retries with exponential backoff, rate-limit/outage error classes (FR-15).
- DeepSeek adapter first (OpenAI-compatible, JSON mode, configurable `base_url`; no strict schema guarantee, so validate and allow one repair retry), then Anthropic and OpenAI adapters, each with provider-specific request formatting and structured-output/JSON mode.
- Token/cost accounting logged to workflow logs only (NFR Cost control).
- Concurrency limiter for model requests (FR-16); low temperature/deterministic settings where supported.
- Config-driven provider and model selection; fail fast with a clear message if the API key is missing.
- Mock provider for tests and offline fixtures.

**Deliverables:** `createProvider(config)` with both adapters and a mock.

**Exit criteria:** Adapter tests with mocked HTTP cover success, malformed output, timeout, 429/5xx retry, and missing-key paths. Smoke test against each real provider.

---

## Phase 4 – Agent framework & Code Review agent

**Goal:** A common agent contract and the first working agent, with schema-validated output.

**Tasks**

- Agent contract: `AgentTask` in → `AgentResult` (findings, observations, status, duration) out; designed so new agents/scanners plug in (NFR Extensibility).
- Orchestrator v1: builds tasks, assigns files/context, runs agents in parallel under the concurrency cap, isolates failures per agent.
- Prompt system (FR-11): role-specific system prompt, PR metadata, changed code, repo instructions, output schema. Repository content wrapped in clear untrusted-content delimiters (PRD §10.5).
- JSON-schema validation of responses (FR-12, FR-13); discard malformed output and record a non-sensitive warning (FR-14).
- Finding validator: path/line checked against the diff, evidence present, confidence/severity thresholds, dedupe, suppress style-only/no-impact findings (FR-19).
- Code Review Agent: correctness, regressions, error handling, API breaks, performance, maintainability.
- Prompt tuning on a small set of fixture PRs.

**Deliverables:** Orchestrator + Code Review agent producing a validated `Finding[]` from a fixture PR (printed to logs, not yet posted).

**Exit criteria:** Fixture with seeded bug yields the expected finding on the correct line; malformed/invalid-line outputs are dropped; one agent failing does not crash the run.

---

## Phase 5 – GitHub publisher (M1: first end-to-end slice)

**Goal:** Findings appear on a real PR as inline review comments, a summary, and a Check Run.

**Tasks**

- Inline comments as a single GitHub Pull Request Review, not issue comments (FR-33); validated against the diff for the reviewed commit (FR-17).
- Default thresholds: inline only for high confidence and severity ≥ `medium`; lower items go to the summary only (FR-18).
- Summary comment with a hidden marker so it can be found and updated (FR-31): status, counts by severity (critical → info), coverage status, security status, test suggestions, skipped files, workflow run link (FR-20, FR-32). Each finding labeled with its source agent (FR-21).
- Check Run `AI PR Review` with `success`/`neutral`/`failure` per config (FR-30).
- Markdown that stays readable in dark mode and mobile (NFR Accessibility).
- Redaction pass so public comments never include credentials or exploit payloads (FR-29).
- Never touch comments the Action didn't create (FR-38).

**Deliverables:** End-to-end run on a sandbox PR.

**Exit criteria:** AC-1, AC-2, AC-3, AC-4 pass on the sandbox repo; GitHub API mocks cover publisher unit tests.

---

## Phase 6 – Test Coverage agent

**Goal:** Test-gap analysis and, where available, real changed-line coverage.

**Tasks**

- LCOV parser and changed-line/changed-file coverage calculation against the diff (FR-22).
- No-report fallback: state "coverage could not be measured" and run a code-based test-gap analysis (FR-23).
- Map changed functions/behaviour to existing tests using the Phase 2 test discovery.
- Test suggestions with scenario, inputs/setup, expected assertion, target file/function (FR-24).
- Clearly separate "suggested missing test" from "verified coverage deficiency" in output and wording (FR-25).
- Add a coverage section to the summary and `ReviewResult.coverage`.

**Deliverables:** Test Coverage agent plus LCOV ingestion.

**Exit criteria:** AC-5 (fixture PR, no report → suggestions labeled as suggestions) and AC-6 (LCOV present → coverage reported) pass.

---

## Phase 7 – Security agent

**Goal:** Security-focused review of changed code with safe public output.

**Tasks**

- Security agent prompts for injection, authn/authz flaws, sensitive-data exposure, unsafe deserialisation, SSRF, path traversal, and dependency risks, tuned for JS/TS and common frameworks (FR-26).
- Include dependency manifest changes (e.g. `package.json`) in security context while keeping lockfile contents excluded.
- High-confidence critical/high findings surfaced in the Check Run and summary (FR-28).
- Public-comment safety: describe risk and mitigation without exploit payloads, live credentials, or sensitive snippets (FR-29).
- Advisory wording clarifying this is not a scanner guarantee (PRD §16).
- Extension point for external scanner output (CodeQL, npm audit, Semgrep, Trivy). Interface only for MVP (FR-27).

**Deliverables:** Security agent wired into the orchestrator.

**Exit criteria:** AC-7 passes — a critical/high-confidence security fixture produces a finding in both summary and Check Run.

---

## Phase 8 – PR lifecycle, enforcement & resilience

**Goal:** Reruns are clean and idempotent, enforcement is configurable, and partial failure degrades gracefully.

**Tasks**

- Head-SHA association; never comment against stale diff positions on `synchronize` (FR-35).
- Idempotency: stable finding fingerprints; no duplicate inline findings or summaries for the same commit (FR-36, AC-10).
- Previous-finding tracking in the summary: resolved / still applicable / no longer evaluated (FR-37).
- Enforcement modes `comment_only` (default), `warn`, `fail_on_threshold`; fail only when severity and confidence thresholds are met (FR-34, AC-12).
- Partial-result handling: provider timeout, invalid output, or single-agent failure → `partial`/neutral with a clear warning, not a crash (FR-14, AC-8).
- Optional Final Review Agent that rejects unsupported findings before posting (§8.3).
- Observability: per-agent status, duration, request size, retries, suppressed counts in logs.

**Deliverables:** Idempotent, policy-driven publish pipeline.

**Exit criteria:** AC-8, AC-10, AC-12 pass; rerun on the same SHA produces no new comments.

---

## Phase 9 – Security hardening & fork safety

**Goal:** Make the Action safe to run in real repositories.

**Tasks**

- Fork PR behaviour: no secrets and no write token by default; safe read-only mode or maintainer-triggered review (PRD §10.2, AC-9).
- Ensure `pull_request_target` is never used to check out or execute untrusted PR code (PRD §10.3). Document the safe pattern.
- Least-privilege permissions: `contents: read`, `pull-requests: write`, `checks: write` only (PRD §10.1).
- Prompt-injection testing: fixtures where code, comments, or PR text instruct the model to leak secrets, change behaviour, or invoke tools. Confirm repository instructions cannot override system rules (PRD §10.4).
- Secret-leak tests: confirm env values and tokens never reach provider requests or logs (FR-10).
- Dependency audit of the Action itself; pin versions.
- Document provider data-retention considerations and path exclusions (NFR Privacy).

**Deliverables:** Security test suite and a security/privacy section in the docs.

**Exit criteria:** AC-9 and AC-11 pass; injection and secret-leak fixtures pass.

---

## Phase 10 – Validation, pilot & release

**Goal:** Prove the MVP meets its targets and ship `v1`.

**Tasks**

- Complete the fixture PR suite covering every acceptance criterion (AC-1 to AC-12) and run it in CI.
- Load/limit tests: PR at configured size limits completes within 5 minutes (NFR Performance).
- Pilot on 1–3 real repositories; collect useful/not-useful feedback per inline finding.
- Tune prompts, thresholds, and the Final Review Agent against pilot data.
- Measure against PRD §13 targets:

  | Metric                   | Target                |
  | ------------------------ | --------------------- |
  | Workflow completion rate | ≥ 95%                 |
  | Median review duration   | < 5 min               |
  | Actionable finding rate  | ≥ 70%                 |
  | False-positive rate      | < 20%                 |
  | Duplicate-comment rate   | < 2%                  |
  | Summary coverage         | ≥ 90% of eligible PRs |

- Documentation: README, installation guide, config reference, permissions, troubleshooting, cost notes.
- Release: version tag `v1`, floating major tag, changelog.

**Deliverables:** Tagged `v1` release, docs, pilot report.

**Exit criteria:** All acceptance criteria pass and pilot metrics meet targets (or have documented, owner-approved exceptions).

---

## Acceptance criteria traceability

| AC  | Description (short)                                     | Phase   |
| --- | ------------------------------------------------------- | ------- |
| 1   | Triggers once per configured event                      | 1, 5    |
| 2   | One structured summary with code, test, security status | 5, 6, 7 |
| 3   | High-confidence issue → inline review comment           | 5       |
| 4   | Low-confidence/info → no inline comment                 | 5       |
| 5   | Missing tests labeled as suggestions when no report     | 6       |
| 6   | LCOV coverage reported                                  | 6       |
| 7   | Critical security fixture → summary and Check Run       | 7       |
| 8   | Invalid output/timeout → safe partial result            | 4, 8    |
| 9   | Fork PRs get no secrets/write token                     | 9       |
| 10  | Same-SHA rerun adds no duplicates                       | 8       |
| 11  | Ignored/generated/lock files excluded and reported      | 2, 9    |
| 12  | `fail_on_threshold` fails only at threshold             | 8       |

## Out of scope (deferred after MVP)

Auto-generated patches or one-click fixes, web dashboard and org-wide reporting, persistent database/analytics, fine-tuned or self-hosted models, deep non-JS/TS language analysis, automatic execution of repository tests, and Jira/Slack/Linear integrations (PRD §14).

## Key risks to watch per phase

| Risk                        | Where it bites | Mitigation phase                                                   |
| --------------------------- | -------------- | ------------------------------------------------------------------ |
| False positives erode trust | 4, 5, 10       | Evidence requirement, thresholds, Final Review Agent (4, 8, 10)    |
| Noisy comments              | 5, 8           | Inline cap, single updated summary, fingerprints (5, 8)            |
| Oversized diffs / cost      | 2, 3           | Size policy, token budgeting, concurrency caps (2, 3)              |
| Prompt injection            | 4, 9           | Untrusted delimiters, schema validation, injection fixtures (4, 9) |
| Secret exposure             | 2, 9           | Filtering, no secrets on forks, leak tests (2, 9)                  |
| Provider outages            | 3, 8           | Retries/backoff, partial-result status (3, 8)                      |
