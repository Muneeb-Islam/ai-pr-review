# Phase 0 – Decisions & Technical Design

**Depends on:** nothing  
**Unblocks:** all later phases  
**PRD refs:** §17 (open decisions), §18 (next step), §6 (assumptions)

## Goal

Close the seven open decisions in the PRD and turn the PRD into a technical design that the implementation phases can follow without re-litigating scope.

## Scope

In: decisions, design document, config schema draft, packaging choice.  
Out: any production code.

## Decisions to confirm

| #   | Decision            | Answer (2026-10-01)                                                       |
| --- | ------------------- | ------------------------------------------------------------------------- |
| 1   | Distribution        | Public reusable Action (fork safety needed from day one)                  |
| 2   | Provider            | DeepSeek primary (OpenAI-compatible); Anthropic and OpenAI also supported |
| 3   | Execution policy    | Run only on PRs targeting `main` or `master`                              |
| 4   | Enforcement default | `comment_only`                                                            |
| 5   | MVP language scope  | Node.js/TypeScript only                                                   |
| 6   | Coverage source     | LCOV (Jest/Vitest) only                                                   |
| 7   | Security tooling    | AI-only; scanner extension point only                                     |

Full rationale and consequences: [docs/decision-log.md](../docs/decision-log.md).

## Tasks

- [x] Get owner answers for decisions 1–7 and record them in a decision log (`docs/decision-log.md`).
- [x] Define the workflow event model, module interfaces, permission and fork strategy, prompt delimiters, error taxonomy, packaging and model handling (`docs/design.md`).
- [x] Draft the config shape and precedence rules (`docs/design.md` §5).
- [ ] Owner review of `docs/design.md`; resolve any comments.
- [ ] Produce the config JSON Schema file (done as part of Phase 1 config work).
- [ ] Pick the default model ID for the example config by checking DeepSeek's current docs (open item).
- [ ] Choose the repo/Action name (deferred; placeholder `ai-pr-review-assistant`).

## Deliverables

- `docs/design.md` (event model, interfaces, permissions, prompts, error taxonomy) — written
- `docs/decision-log.md` — written
- Config JSON Schema — moved to Phase 1

## Exit criteria

- Owner has signed off on decisions 1–7 (given) and on `docs/design.md`.
- No open questions that block Phase 1 or 2.

## Risks

- DeepSeek has no strict JSON-schema enforcement, so malformed output is more likely than with the other providers; Phases 3 and 4 handle this with validation and one repair retry.
- Public distribution means fork-PR handling can't wait for Phase 9; the guard is built in Phase 1.
