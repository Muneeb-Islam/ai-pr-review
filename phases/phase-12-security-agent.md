# Phase 12 – Security Agent

**Depends on:** Phases 7, 9  
**Unblocks:** Phases 13, 15  
**Milestone:** M3  
**Refs:** FR-26–FR-29, AC-7, scope §10

## Goal

Review changed code and dependency manifests for security weaknesses; surface high-confidence critical and high findings in the summary and Check Run without exposing sensitive detail publicly.

## Tasks

### Security agent (FR-26)
- [ ] Prompt for JS/TS and common frameworks (Express, Fastify, Next.js, NestJS, React) covering: injection (SQL, NoSQL, command, template), authentication and authorisation flaws, sensitive-data exposure and insecure logging, unsafe deserialisation, SSRF, path traversal, XSS and unsafe HTML, weak crypto or randomness, insecure configuration (CORS, cookies, TLS).
- [ ] Output category `security` with severity, confidence, evidence, impact and mitigation.

### Dependency review
- [ ] Include `package.json` changes (new or upgraded dependencies, install scripts) in the security context; keep lockfile contents excluded.
- [ ] Flag typosquat-like names, unpinned git or URL dependencies, new install scripts.

### Output integration (FR-28)
- [ ] High-confidence critical or high findings appear in the Check Run output and the summary, with an overall security status.
- [ ] Inline comments follow the normal thresholds.
- [ ] Dashboard: security findings are filterable by category and highlighted in run detail.

### Public-comment safety (FR-29)
- [ ] Describe risk and mitigation without exploit payloads, live credentials or sensitive snippets; extend the Phase 9 redaction with security-specific rules; the prompt forbids exploit code.
- [ ] Summary states the review is advisory and not a replacement for SAST or dependency scanning.

### Scanner extension point (FR-27)
- [ ] `ScannerAdapter` interface turning external output (SARIF, `npm audit --json`) into `Finding[]`; one documented stub; no adapters required.

## Testing

- Seeded fixtures: SQL injection, path traversal, hard-coded token, missing authorisation check, SSRF.
- Critical fixture yields a finding in the summary and Check Run (AC-7).
- Benign change yields no security finding.
- A finding containing a token-like string is sanitised before posting.
- Dependency fixtures: new install script, git URL dependency.

## Deliverables

- Security agent integrated into the orchestrator, summary, Check Run and dashboard.

## Exit criteria

- AC-7 passes; no fixture output contains exploit payloads or credential-like strings.

## Risks

- Generic security advice creates noise; require concrete diff evidence and keep the confidence threshold.
- Public findings can reveal unpatched issues; keep detail at the risk level.
