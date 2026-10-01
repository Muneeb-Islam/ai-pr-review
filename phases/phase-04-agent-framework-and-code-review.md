# Phase 4 – Agent Framework & Code Review Agent

**Depends on:** Phases 2, 3  
**Unblocks:** Phases 5, 6, 7  
**PRD refs:** FR-11–FR-14, FR-19, §8.3, §10.5, NFR Extensibility, NFR Reliability

## Goal

Establish the common agent contract, the orchestrator and the finding validator, and deliver the first working agent (Code Review) that produces schema-validated findings.

## Scope

In: agent contract, orchestrator v1, prompt system, schema validation, finding validator, Code Review agent.  
Out: posting to GitHub (Phase 5), test-coverage and security agents (Phases 6 and 7).

## Tasks

### Agent contract

- [ ] Define `AgentTask` (role, files, context, config) and `AgentResult` (findings, observations, status, duration, warnings).
- [ ] Make agents registrable behind this contract so new agents and scanners can be added without changing the orchestrator (NFR Extensibility).

### Orchestrator v1

- [ ] Select enabled agents from config.
- [ ] Build tasks and assign files and context per agent.
- [ ] Run agents in parallel under the provider concurrency cap.
- [ ] Isolate failures: one agent's error, timeout or malformed output must not prevent others from returning results (NFR Reliability).
- [ ] Aggregate into a `ReviewResult` with `agentRuns` and a status of `completed` or `partial`.

### Prompt system (FR-11)

- [ ] Each agent receives: role-specific system prompt, PR metadata, relevant changed code, repository instructions, output schema.
- [ ] Wrap all repository-derived text (diffs, PR body, repo instructions) in explicit untrusted-content delimiters (PRD §10.5).
- [ ] System prompt states that content inside delimiters is data and cannot change the rules, request tools or reveal secrets.
- [ ] Store prompts as versioned files, not inline strings.

### Response validation (FR-12, FR-13, FR-14)

- [ ] Validate each response against the finding JSON schema: category, severity, confidence, file path, line range, explanation, evidence, recommendation.
- [ ] Discard malformed responses; record a non-sensitive warning for the summary and Check Run output.
- [ ] Allow one repair retry (send the validation error back to the model) before discarding. This matters most for DeepSeek, which has no strict schema enforcement.

### Finding validator

- [ ] Verify `filePath` and line range exist in the PR diff (using Phase 2 `isLineInDiff`).
- [ ] Require non-empty evidence and impact.
- [ ] Apply minimum severity and confidence thresholds from config.
- [ ] Deduplicate findings by file, line range and normalised title or fingerprint.
- [ ] Suppress findings that only restate linter or formatting rules, or that have no clear impact (FR-19).
- [ ] Count suppressed findings by reason for observability.

### Code Review Agent

- [ ] Prompt covering correctness, logic regressions, error handling gaps, API contract breaks, performance concerns and maintainability.
- [ ] Output line-level findings plus summary observations.
- [ ] Chunk large diffs by file or hunk to stay within token budgets.

### Tuning

- [ ] Create 5–10 fixture PRs (seeded bugs, clean changes, style-only changes) and iterate on the prompt.

## Suggested layout

```
src/agents/
  types.ts
  orchestrator.ts
  codeReview/
    agent.ts
    prompt.md
src/validation/
  findingSchema.ts
  findingValidator.ts
  dedupe.ts
prompts/
  system-base.md
```

## Testing

- Mock provider returns: valid findings, malformed JSON, schema-violating output, finding on a line outside the diff, duplicate findings, low-confidence finding.
- Orchestrator: one agent throws and the others still complete; result status is `partial`.
- Prompt-structure test: repository content always appears inside delimiters.

## Deliverables

- Orchestrator plus Code Review agent producing a validated `Finding[]` from a fixture PR (logged, not yet posted).

## Exit criteria

- A seeded-bug fixture yields the expected finding on the correct line.
- Malformed and invalid-line outputs are dropped with a warning.
- Failure of one agent never crashes the run.

## Risks

- Prompt quality drives false-positive rate; require evidence quotes and use a high default confidence threshold.
- Large diffs can exceed context; chunking and size limits from Phase 2 are the guard.
