# Phase 1 – Project Foundation

**Depends on:** Phase 0  
**Unblocks:** Phases 2, 3  
**PRD refs:** FR-01–FR-05, NFR Observability, §11 (workflow and config examples), §12 (data model)

## Goal

A buildable, tested TypeScript GitHub Action skeleton that loads configuration, routes events and authenticates to GitHub, ready for real logic.

## Scope

In: repo tooling, core types, config loader, event routing, GitHub client, logger, CI.  
Out: fetching diffs, calling AI providers, posting results.

## Tasks

### Tooling

- [x] Initialise the repo: TypeScript (strict), ESLint, Prettier, Vitest or Jest.
- [x] Add `action.yml` (inputs: `provider`, `model`, config path, etc.) and a bundler (`ncc`/`esbuild`) producing `dist/`.
- [x] Add CI for this repo: lint, typecheck, test, build, and a check that `dist/` is up to date.

### Core types

- [x] Implement `Severity`, `Category`, `Finding`, `ReviewResult` exactly as in PRD §12.
- [x] Add runtime validators for these types (zod or ajv) so the same definitions serve Phase 4 schema validation.

### Configuration (FR-03, FR-04)

- [x] Load `.github/ai-pr-review.yml` and merge with Action inputs using the precedence rules from Phase 0.
- [x] Validate against the config schema; fail with readable messages naming the offending key.
- [x] Defaults: `mode: comment_only`, `minimum_severity: medium`, `minimum_confidence: 0.80`, `max_changed_files: 40`, `max_patch_characters: 120000`, all three agents enabled.
- [x] Provider, model, ignore globs, coverage path, comment policy and blocking policy all come from config, never hard-coded.

### Event routing (FR-01, FR-02, FR-05)

- [x] Handle `pull_request` types `opened`, `reopened`, `synchronize`, `ready_for_review`.
- [x] Handle `workflow_dispatch` (PR number input) and optional `/ai-review` comment command.
- [x] Draft PR behaviour switch: summary-only until ready for review (default).
- [x] Target-branch guard: review only when the PR base is in `review.target_branches` (default `[main, master]`); otherwise log and exit 0. The example workflow also sets `on.pull_request.branches: [main, master]`.
- [x] Fork-PR guard (public repo, decision 1): detect forks and make no provider call and no write call; log why. Full hardening comes in Phase 9, but this guard must exist from the start so secrets are never used on fork PRs.
- [x] Ignore all other events with a clear log line, not an error.

### Infrastructure

- [x] GitHub client wrapper (Octokit) with retry and rate-limit handling.
- [x] Structured logger: run ID, PR number, agent status, duration. Never log source content or secrets.
- [x] Sample workflow and example config from PRD §11 under `examples/`, using `provider: deepseek` and `DEEPSEEK_API_KEY`.
- [x] Config schema accepts `provider: anthropic | openai | deepseek` and optional `base_url`; produce the config JSON Schema file from `docs/design.md` §5.
- [ ] Create the sandbox GitHub repo for end-to-end testing: add the workflow, a `DEEPSEEK_API_KEY` secret, and a `main` branch to open PRs against. (Needed from Phase 5; create it now so the foundation can be verified.)
- [x] Keep the Action/repo name in a single place (placeholder `ai-pr-review-assistant`).

## Suggested layout

```
src/
  main.ts            # entry point
  config/            # loader, schema, defaults
  events/            # event router
  github/            # Octokit wrapper
  types/             # Finding, ReviewResult, etc.
  util/logger.ts
examples/
  workflow.yml
  ai-pr-review.yml
```

## Testing

- Config: valid, missing file (defaults apply), invalid values, input-vs-file precedence.
- Event routing: each supported event, an unsupported event, draft vs. ready PR.

## Deliverables

- Action that runs in a sandbox repo and logs the parsed config and detected event type.
- CI green on the Action's own repo.

## Exit criteria

- Unit tests for config validation and event routing pass.
- Action executes in a sandbox repository from a real PR event.

## Risks

- Forgetting to commit a rebuilt `dist/` breaks the Action; the CI freshness check prevents this.
