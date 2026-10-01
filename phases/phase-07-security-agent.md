# Phase 7 – Security Agent

**Depends on:** Phases 4, 5  
**Unblocks:** Phases 8, 9  
**Milestone:** M2 – feature complete  
**PRD refs:** FR-26–FR-29, §8.3, §16, AC-7

## Goal

Review changed code and dependency manifests for security weaknesses and surface high-confidence critical and high findings in the summary and Check Run, without exposing sensitive details publicly.

## Scope

In: Security agent, dependency-change review, Check Run integration, public-comment safety, scanner extension point.  
Out: running CodeQL, Semgrep, npm audit or Trivy (interface only for MVP).

## Tasks

### Security agent (FR-26)

- [ ] Role-specific prompt for JS/TS and common frameworks (Express, Next.js, NestJS, React) covering:
  - injection (SQL, NoSQL, command, template)
  - authentication and authorisation flaws
  - sensitive-data exposure and insecure logging
  - unsafe deserialisation
  - SSRF
  - path traversal
  - XSS and unsafe HTML handling
  - weak crypto or randomness
  - insecure configuration changes (CORS, cookies, TLS)
- [ ] Output uses category `security` with severity, confidence, evidence, impact and mitigation.

### Dependency review

- [ ] Include changes to `package.json` (new or upgraded dependencies, install scripts) in the security context.
- [ ] Keep lockfile contents excluded from prompts, consistent with Phase 2.
- [ ] Flag suspicious additions: typosquat-like names, unpinned git or URL dependencies, new install scripts.

### Check Run and summary (FR-28)

- [ ] High-confidence critical or high security findings appear in the Check Run output and the summary.
- [ ] Add a "Security" section to the summary with an overall security status.
- [ ] Inline comments follow the normal threshold rules.

### Public-comment safety (FR-29)

- [ ] Describe the risk and mitigation without working exploit payloads, live credentials or sensitive code excerpts.
- [ ] Extend the Phase 5 redaction pass with security-specific rules.
- [ ] Prompt instructs the agent not to produce exploit code.

### Advisory wording

- [ ] Summary states that the review is advisory and not a replacement for SAST or dependency scanning (PRD §16).

### Scanner extension point (FR-27)

- [ ] Define a `ScannerAdapter` interface that converts external tool output (SARIF, `npm audit --json`) into `Finding[]`.
- [ ] No adapters required for MVP; include one stub and documentation.

## Suggested layout

```
src/agents/security/
  agent.ts
  prompt.md
  dependencies.ts    # manifest diff analysis
src/scanners/
  types.ts           # ScannerAdapter
```

## Testing

- Fixtures with seeded vulnerabilities: SQL injection, path traversal, hard-coded token, missing authorisation check, SSRF.
- Critical fixture yields a finding in both summary and Check Run (AC-7).
- Benign change yields no security finding (false-positive guard).
- Output redaction test: a finding containing a token-like string is sanitised before posting.
- Dependency fixtures: new install script, git URL dependency.

## Deliverables

- Security agent integrated into the orchestrator, summary and Check Run.

## Exit criteria

- AC-7 passes.
- No fixture output contains exploit payloads or credential-like strings.

## Risks

- Over-reporting generic security advice; require concrete evidence in the diff and apply the confidence threshold.
- Findings exposing vulnerabilities in public repos before they're fixed; keep detail at the risk level and let maintainers decide how to handle sensitive reports.
