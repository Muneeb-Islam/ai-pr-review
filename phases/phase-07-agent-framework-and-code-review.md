# Phase 7 – Agent Framework & Code Review Agent

**Depends on:** Phases 5, 6  
**Unblocks:** Phases 8, 11, 12  
**Refs:** FR-11–FR-14, FR-19, design §10, §11, AC-8

## Goal

Establish the common agent contract, orchestrator and finding validator in `packages/core`, and deliver the first agent (Code Review) producing schema-validated findings.

## Tasks

### Agent contract and orchestrator
- [ ] Types from design §10: `AgentTask`, `AgentResult`, `Agent`. New agents and scanners register behind this contract.
- [ ] Orchestrator: select enabled agents, build tasks, assign files and context, run agents in parallel under the provider concurrency cap, isolate failures per agent, forward the `AbortSignal`.
- [ ] Aggregate into an engine result with agent runs (status, duration, tokens, retries), warnings and a status of `completed` or `partial`. The engine does not touch the database; the worker persists results (Phase 8).

### Prompt system (FR-11)
- [ ] Prompts as versioned files (`prompts/`); each has role, task, rubric, output schema and the untrusted-content rule (design §11).
- [ ] Wrap diffs, PR text and repo instructions in per-run random delimiters.
- [ ] Chunk large diffs by file or hunk to stay within token budgets.

### Response validation (FR-12–FR-14)
- [ ] Validate every response against the finding schema.
- [ ] **One repair retry**: send the validation error back to the model, then discard on failure (important for DeepSeek). Record a non-sensitive warning.

### Finding validator (FR-19)
- [ ] Path and line range must exist in the diff (`isLineInDiff`); evidence and impact required; apply minimum severity and confidence.
- [ ] Deduplicate by fingerprint (design §12); suppress style-only, no-impact or linter-restating findings.
- [ ] Count suppressed findings by reason.

### Code Review agent
- [ ] Prompt for correctness, regressions, error handling, API contract breaks, performance and maintainability. Output line-level findings and observations.
- [ ] Create 5–10 fixture PRs (seeded bugs, clean changes, style-only) and tune the prompt against them.

## Suggested layout

```
packages/core/src/
  agents/{types.ts, orchestrator.ts, codeReview/}
  validation/{findingSchema.ts, findingValidator.ts, dedupe.ts, fingerprint.ts}
  prompts/
```

## Testing

- Mock provider returns: valid findings, malformed JSON, schema violations, a finding outside the diff, duplicates, low-confidence findings, a repaired response.
- One agent throws or times out; the others complete and the result is `partial` (AC-8).
- Prompt-structure test: repository content always sits inside delimiters.
- Seeded-bug fixture yields the expected finding on the correct line.

## Deliverables

- Orchestrator, validator and Code Review agent callable as `runReview(context, config, provider, signal)`.

## Exit criteria

- Seeded bug found on the right line; malformed and invalid-line outputs dropped with a warning; one failing agent never crashes the run.

## Risks

- Prompt quality drives the false-positive rate. Require evidence quotes and a high default confidence threshold.
- Large diffs exceed context. Chunking plus Phase 5 size limits are the guard.
