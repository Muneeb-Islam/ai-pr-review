# Decision Log

Answers to the Phase 0 decisions (PRD §17) plus project-level questions. Recorded 2026-10-01.

| #   | Decision            | Answer                                                                    | Consequence                                                                                                                                                                                  |
| --- | ------------------- | ------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Distribution        | **Public reusable GitHub Action** (Marketplace-ready)                     | Fork-PR safety is a day-one requirement, not a late hardening step. Docs, README and versioned releases are first-class deliverables. Phase 9 becomes release-blocking.                      |
| 2   | Provider            | **DeepSeek** (primary). Anthropic and OpenAI adapters remain per the PRD. | Adds a third provider. DeepSeek's API is OpenAI-compatible, so it is implemented as an OpenAI-compatible adapter with a configurable `base_url`. See "Provider notes" below.                 |
| 3   | Execution policy    | **Run on pull requests targeting `main` or `master` only**                | Workflow `on.pull_request.branches: [main, master]` plus a runtime guard `review.target_branches` (default `[main, master]`). PRs to other branches are skipped with a log line, no comment. |
| 4   | Enforcement default | **`comment_only`**                                                        | Check Run is `success`/`neutral`. `warn` and `fail_on_threshold` stay available but opt-in.                                                                                                  |
| 5   | MVP language scope  | Node.js/TypeScript only (recommended)                                     | Test discovery and security prompts tuned for JS/TS. Other text languages are reviewed by prompt only.                                                                                       |
| 6   | Coverage source     | LCOV (Jest/Vitest) only (recommended)                                     | JUnit and Codecov deferred.                                                                                                                                                                  |
| 7   | Security tooling    | AI-only review (recommended)                                              | `ScannerAdapter` interface defined, no adapters implemented.                                                                                                                                 |
| 8   | Sandbox repo        | **To be created**                                                         | Added as a Phase 1 task. Needed for end-to-end testing from Phase 5.                                                                                                                         |
| 9   | Coding agent        | **Claude Code**, one phase per session                                    | Phase files are written as self-contained session briefs. `docs/design.md` is read at the start of every session.                                                                            |
| 10  | Action / repo name  | **Deferred**                                                              | Use placeholder `ai-pr-review-assistant`. Keep the name in one place (`action.yml`, README, examples) so renaming is a single pass.                                                          |

## Provider notes (DeepSeek)

- **API shape:** OpenAI-compatible chat completions at a configurable base URL; key in `DEEPSEEK_API_KEY`.
- **Structured output:** supports JSON mode but not strict JSON-schema enforcement the way OpenAI structured outputs do. The adapter must therefore validate every response with our own schema and allow one repair retry (Phase 3 and 4).
- **Model IDs:** configuration only, never in code. Confirm current model names against DeepSeek's documentation when writing the example config, since names change.
- **Privacy:** the hosted DeepSeek API processes data on servers operated by a China-based company. This repo is public, but the Action will be installed on other people's private repos. The README and `docs/privacy.md` must state this plainly, and the Action should log a one-line notice of which provider receives code. Users who can't accept this should pick another provider.
- **Rate limits and latency:** can be spiky; rely on the Phase 3 retry, backoff and concurrency controls.

## Open items

- Repo and Action name (decision 10).
- Default model identifier for the example config (decision 2); pick when Phase 3 starts.
- Sandbox repo creation (decision 8).
