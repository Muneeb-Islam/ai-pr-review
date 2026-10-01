# Phase 9 – Security Hardening & Fork Safety

**Depends on:** Phases 5–8  
**Unblocks:** Phase 10  
**Milestone:** M3 – MVP release candidate  
**PRD refs:** §10 (security and permission model), FR-10, NFR Security, NFR Privacy, AC-9, AC-11

## Goal

Make the Action safe to run in real repositories: no secret leakage to untrusted code, no privilege escalation through forks, and resistance to prompt injection.

> **Note (decision 1: public Action):** the basic fork guard is built in Phase 1. This phase verifies and hardens it, and it blocks the public release.

## Scope

In: fork behaviour, permission model, prompt-injection and secret-leak testing, supply-chain hygiene of the Action itself, privacy documentation.  
Out: new product features.

## Tasks

### Fork PR handling (PRD §10.2, AC-9)

- [ ] Detect fork PRs (`head.repo.full_name !== base.repo.full_name`).
- [ ] Default: never expose API secrets or a write token to fork-PR runs; run in safe read-only mode or skip with a clear message.
- [ ] Optional maintainer-triggered review for forks (for example a label or `workflow_dispatch` applied by a maintainer) that only proceeds when checkout safeguards are met.
- [ ] Ensure no step executes code from the PR head with secrets available.

### `pull_request_target` (PRD §10.3)

- [ ] Never check out or execute untrusted PR code under `pull_request_target`.
- [ ] If supported at all, fetch only diff data through the API and never run PR scripts.
- [ ] Document the safe pattern and the dangerous pattern with examples.

### Least privilege (PRD §10.1)

- [ ] Document and test the minimal permissions: `contents: read`, `pull-requests: write`, `checks: write`.
- [ ] Detect missing permissions at startup and report a clear actionable warning.
- [ ] Request nothing extra unless an optional integration needs it.

### Prompt-injection resistance (PRD §10.4, §10.5)

- [ ] Adversarial fixtures: code comments, README text, PR descriptions and repository instruction files that tell the model to reveal secrets, ignore rules, approve the PR, call tools or alter output format.
- [ ] Confirm: model output is validated by schema, no tool or network capability is given to agents, and repository instructions cannot override system rules or change GitHub permissions.
- [ ] Confirm injected instructions never cause actions beyond posting validated findings.

### Secret-leak testing (FR-10)

- [ ] Test: set fake secrets in the environment and files; assert none appear in any provider request body, log line or posted comment.
- [ ] Verify secret-pattern file exclusion end to end (AC-11).
- [ ] Verify logs contain no source content.

### Supply chain

- [ ] Audit the Action's own dependencies (`npm audit`), pin versions, minimise dependency count.
- [ ] Pin third-party actions by commit SHA in this repo's workflows.
- [ ] Review the bundled `dist/` reproducibility.

### Privacy documentation (NFR Privacy)

- [ ] Document what code context is sent to which provider.
- [ ] Document provider data-retention considerations and how to exclude sensitive paths.
- [ ] Document how to disable the Action on specific repos or paths.
- [ ] State plainly that DeepSeek's hosted API is operated by a China-based company and that code context is sent to it; list the other providers as alternatives for users who can't accept this.

## Testing

- Fork fixture event payload: no provider call, no write call, explanatory message.
- Same-repo event: normal operation.
- Permission-missing simulation (403): clear warning, graceful exit.
- Injection suite: automated assertions on outputs and on the set of API calls made.
- Leak suite: scan captured requests, logs and comments for planted canary strings.

## Deliverables

- Security test suite, `docs/security.md` and `docs/privacy.md`.

## Exit criteria

- AC-9 and AC-11 pass.
- All prompt-injection and secret-leak fixtures pass.
- No high or critical vulnerabilities in the Action's dependencies.

## Risks

- Fork PRs get less review by design; communicate this clearly so users don't assume coverage.
- Prompt-injection defences are never absolute; layered validation of output and a no-tools design limit the blast radius.
