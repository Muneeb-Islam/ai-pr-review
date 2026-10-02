# Product Requirements Document

## Multi-Agent Coding & PR Review Assistant

**Version:** 0.1 (draft)  
**Date:** 29 September 2026  
**Status:** Ready for scope confirmation

## 1. Product summary

The Multi-Agent Coding & PR Review Assistant is a GitHub Actions-based developer tool that automatically reviews pull requests. Whenever a pull request is opened, synchronized with new commits, or manually re-run, the assistant evaluates the changed code through specialised review agents, then posts concise and actionable feedback directly in the GitHub pull request.

The initial release focuses on four outcomes:

1. Find likely bugs, regressions, maintainability issues, and missed edge cases in the PR diff.
2. Assess the tests affected by the change and suggest missing unit/integration tests.
3. Identify security risks in changed code and dependencies.
4. Give reviewers structured, evidence-backed findings without noisy or duplicated comments.

The assistant is advisory by default: it does not merge, modify repository files, or block a pull request unless the repository explicitly enables blocking status checks.

## 2. Problem statement

Code reviews are time-consuming and inconsistent, particularly for small teams where reviewers must simultaneously assess correctness, test coverage, security, and code quality. Existing linters and test suites catch known rules, but they do not reliably explain how a specific change may break business logic or what test is missing.

The product adds a consistent first-pass review to every pull request. It narrows the work for human reviewers by highlighting high-confidence risks and test gaps with exact file and line references.

## 3. Goals

- Run automatically from a repository's GitHub Actions workflow on pull-request events.
- Analyse only the pull request context necessary to produce a useful review.
- Use multiple specialised AI agents while presenting one consolidated result.
- Post inline comments only for high-confidence, actionable issues.
- Publish a clear PR summary covering findings, test coverage, security, and suggestions.
- Support either Anthropic Claude or OpenAI models through repository secrets and configuration.
- Keep the design reusable across repositories and language stacks, beginning with JavaScript/TypeScript projects.

## 4. Non-goals for MVP

- Automatically committing fixes, approving PRs, or merging branches.
- Replacing SAST, dependency scanning, CI tests, or human review.
- Reviewing the entire repository on every PR.
- Guaranteeing that all vulnerabilities or defects are found.
- Analysing source code from untrusted fork PRs with write permissions or exposing API secrets to them.
- Building a hosted dashboard, billing system, or multi-tenant user management portal.

## 5. Target users

| User | Need |
|---|---|
| Developer opening a PR | Fast feedback on potential defects and missing tests before a human review. |
| Code reviewer / tech lead | A concise risk summary and precise findings to prioritise review time. |
| Engineering manager | More consistent review standards and a visible signal of PR quality. |
| DevOps / repository administrator | Easy GitHub Actions installation, safe secret handling, and configurable behaviour. |

## 6. Assumptions

- The MVP is delivered as a reusable GitHub Action (or an Action workflow package), not a standalone SaaS application.
- GitHub Actions is the execution environment.
- Node.js and TypeScript are used for the Action implementation.
- The first supported codebase type is Node.js/TypeScript; the review prompt may inspect other text-based languages, but language-aware test discovery is initially optimised for JS/TS.
- The repository owner provides either `ANTHROPIC_API_KEY` or `OPENAI_API_KEY` as a GitHub Actions secret.
- AI model use is configurable. The default should be a capable code-review model selected by the repository owner; model names must not be hard-coded into logic.
- Existing test reports, where available, use common formats such as LCOV or JUnit.

## 7. User flow

1. A developer opens a PR or pushes new commits to it.
2. GitHub Actions triggers the review workflow.
3. The Action safely obtains PR metadata, changed files, patches, existing review comments, and configured test/coverage artefacts.
4. An orchestrator creates focused tasks for the code-quality, test-coverage, and security agents.
5. Each agent returns structured findings with severity, confidence, evidence, location, and recommendation.
6. The orchestrator removes duplicates, resolves conflicts, suppresses low-confidence findings, and applies the repository's review policy.
7. The Action posts:
   - inline GitHub review comments for qualifying code findings;
   - one PR summary comment with all findings, test/coverage analysis, and unit-test suggestions;
   - an optional GitHub Check Run result.
8. On a later PR update, the Action re-runs and updates its summary rather than adding redundant review noise.

## 8. Functional requirements

### 8.1 Triggering and configuration

| ID | Requirement |
|---|---|
| FR-01 | The Action must run on `pull_request` events for at least `opened`, `reopened`, `synchronize`, and `ready_for_review`. |
| FR-02 | It must support manual re-run through `workflow_dispatch` or a PR comment command, such as `/ai-review`, if configured. |
| FR-03 | Repositories must be able to enable/disable individual agents and set review thresholds using a versioned config file, proposed path `.github/ai-pr-review.yml`. |
| FR-04 | The Action must read model provider, model identifier, maximum changed files, maximum patch size, comment policy, and blocking policy from configuration or Action inputs. |
| FR-05 | Draft PR behaviour must be configurable; the recommended default is summary-only until the PR is marked ready for review. |

### 8.2 PR context collection

| ID | Requirement |
|---|---|
| FR-06 | The Action must collect PR title, description, base and head SHAs, changed file metadata, unified diff/patches, and changed line locations through the GitHub API. |
| FR-07 | It must include nearby code context only when necessary to understand a changed line, respecting configured size limits. |
| FR-08 | It must identify and exclude binary files, generated files, lockfiles, vendored dependencies, secrets, and configured ignored paths from AI prompts by default. |
| FR-09 | It must detect when the PR is too large for a reliable review and post a transparent summary explaining that review was limited or skipped. |
| FR-10 | It must never send GitHub Action secrets, environment variable values, tokens, or files matching configurable secret patterns to an AI provider. |

### 8.3 Specialised agent roles

| Agent | Responsibilities | Output |
|---|---|---|
| Orchestrator | Builds the review plan, assigns files/context, validates responses, deduplicates findings, applies policy, and prepares GitHub output. | Consolidated review result. |
| Code Review Agent | Detects correctness issues, logic regressions, error handling gaps, API contract breaks, performance concerns, and maintainability problems in the diff. | Line-level findings and summary observations. |
| Test Coverage Agent | Maps changed behaviour to existing tests and coverage reports; identifies untested paths and proposes concrete test cases. | Coverage assessment and test suggestions. |
| Security Agent | Looks for insecure changes such as injection, auth/authorisation flaws, sensitive-data exposure, unsafe deserialisation, SSRF, path traversal, and dependency risks. | Security findings with risk and mitigation. |
| Final Review Agent (optional) | Checks that proposed findings are supported by the diff and removes false positives before posting. | Approved/rejected findings. |

### 8.4 AI request and response handling

| ID | Requirement |
|---|---|
| FR-11 | Each agent must receive a role-specific system prompt, PR metadata, relevant changed code, repository instructions, and output schema. |
| FR-12 | Agent responses must be machine-validated against a JSON schema before they can create GitHub comments. |
| FR-13 | Every finding must include category, severity, confidence, file path, line range (when applicable), explanation, evidence, and recommended change or test. |
| FR-14 | The system must discard malformed responses and surface a non-sensitive execution warning in the summary/check output. |
| FR-15 | The provider layer must support Anthropic and OpenAI through a common interface, allowing retries, timeouts, token budgeting, and provider-specific request formatting. |
| FR-16 | The system must use deterministic controls where available and cap concurrent model requests to manage cost and GitHub Action runtime. |

### 8.5 Code review findings

| ID | Requirement |
|---|---|
| FR-17 | Inline comments must point to a valid line in the PR diff and must not be posted on unchanged code. |
| FR-18 | The default inline-comment threshold must be high confidence and severity `medium` or above. Lower-confidence observations belong only in the summary. |
| FR-19 | Findings that merely restate linter formatting rules, lack a clear impact, or duplicate an existing finding must be suppressed. |
| FR-20 | The review summary must group findings by severity: critical, high, medium, low, and informational. |
| FR-21 | The Action must label each finding with its source agent and provide a concise explanation suitable for a human reviewer. |

### 8.6 Test coverage and suggestions

| ID | Requirement |
|---|---|
| FR-22 | Where coverage reports are available, the Action must report changed-file and changed-line coverage when technically possible. |
| FR-23 | When no coverage artefact exists, the Action must state that coverage could not be measured and perform a code-based test-gap analysis instead. |
| FR-24 | Test suggestions must identify the intended scenario, inputs/setup, expected assertion, and relevant target file/function where identifiable. |
| FR-25 | The Action must distinguish between a missing test suggestion and a verified coverage deficiency. |

### 8.7 Security analysis

| ID | Requirement |
|---|---|
| FR-26 | The Security Agent must review changed code for common application security weaknesses relevant to the language and framework. |
| FR-27 | The Action may consume output from existing tools such as CodeQL, npm audit, Dependabot, Semgrep, or Trivy when configured, but those tools are not required for the base MVP. |
| FR-28 | High-confidence critical or high security findings must be included in the GitHub Check Run result and PR summary. |
| FR-29 | The assistant must avoid exposing exploit payloads, live credentials, or sensitive code fragments in public PR comments. |

### 8.8 GitHub output

| ID | Requirement |
|---|---|
| FR-30 | The Action must create one GitHub Check Run named `AI PR Review` with conclusion `success`, `neutral`, or `failure` according to configuration. |
| FR-31 | The Action must post one identifiable summary comment and update that same comment on reruns when GitHub permissions allow. |
| FR-32 | The summary must include review status, finding counts by severity, coverage status, security status, test suggestions, skipped files, and a link/reference to the workflow run. |
| FR-33 | Inline code comments must be published as a GitHub Pull Request Review, not as generic issue comments. |
| FR-34 | The Action must support `comment_only` (default), `warn`, and `fail_on_threshold` enforcement modes. |

### 8.9 PR updates and comment lifecycle

| ID | Requirement |
|---|---|
| FR-35 | On `synchronize`, the Action must associate results with the latest head SHA and not comment against stale diff positions. |
| FR-36 | It must not repost the same inline finding for the same commit SHA. |
| FR-37 | The summary must show which previous findings are resolved, still applicable, or no longer evaluated where that determination is available. |
| FR-38 | The Action must preserve human comments and never edit/delete comments it did not create. |

## 9. Non-functional requirements

| Area | Requirement |
|---|---|
| Reliability | A single agent/provider failure must not prevent collection of other agents' results. The workflow should finish with `neutral` and a clear warning when partial analysis is available. |
| Performance | For a PR within configured limits, target a completed review within 5 minutes, excluding repository test execution time. |
| Cost control | Enforce per-run file, diff, request, and token limits. Report estimated model usage in workflow logs, never in a public PR comment by default. |
| Security | Use least-privilege GitHub token permissions. API keys must be accessed only from GitHub secrets. |
| Privacy | Send only required code context to the selected model provider. Document provider data-retention considerations and offer exclusions for sensitive paths. |
| Observability | Emit structured logs with run ID, PR number, agent status, duration, request size, retry count, and suppressed-finding counts; do not log source content or secrets. |
| Extensibility | New agents and scanners should be addable behind a common task/output contract. |
| Accessibility | PR comments must use clear language and GitHub-flavoured Markdown that remains readable in dark mode and mobile views. |

## 10. Security and permission model

1. Default GitHub Actions permissions: `contents: read`, `pull-requests: write`, and `checks: write`. Request no additional permissions unless an optional integration needs them.
2. The Action must run privileged comment-posting only for trusted repository branches. Fork PRs must use a safe read-only mode or require a maintainer-triggered manual review after checkout safeguards are met.
3. The Action must not use `pull_request_target` to check out or execute untrusted PR code.
4. Repository-provided instructions may guide review style but must not override system safety rules, disclose secrets, invoke tools, or change GitHub permissions.
5. Inputs sent to AI providers must be clearly delimited as untrusted repository content to reduce prompt-injection risk.
6. Before posting comments, validate paths and line numbers against the GitHub diff for the reviewed commit.

## 11. Proposed architecture

### Components

| Component | Responsibility |
|---|---|
| GitHub Action entry point | Parses inputs, loads configuration, authenticates GitHub API, coordinates workflow lifecycle. |
| Context collector | Fetches PR diff, file metadata, code context, test/coverage artefacts, and previous bot results. |
| Policy engine | Applies ignore rules, size limits, severity/confidence thresholds, permissions, and enforcement mode. |
| Agent orchestrator | Selects agents, distributes context, invokes providers, aggregates results, and handles fallbacks. |
| AI provider adapters | Typed adapters for Anthropic and OpenAI. |
| Finding validator | Validates JSON schema, evidence, diff positions, duplication, and safety before publication. |
| GitHub publisher | Creates or updates Check Runs, summary comment, and inline Pull Request Review comments. |

### Configuration example

```yaml
# .github/ai-pr-review.yml
provider: anthropic
model: claude-sonnet
review:
  mode: comment_only
  minimum_severity: medium
  minimum_confidence: 0.80
  max_changed_files: 40
  max_patch_characters: 120000
agents:
  code_review: true
  test_coverage: true
  security: true
coverage:
  lcov_path: coverage/lcov.info
ignore:
  - "dist/**"
  - "coverage/**"
  - "**/*.lock"
```

### Workflow example

```yaml
name: AI PR Review
on:
  pull_request:
    types: [opened, reopened, synchronize, ready_for_review]

permissions:
  contents: read
  pull-requests: write
  checks: write

jobs:
  review:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: your-org/ai-pr-review-assistant@v1
        with:
          provider: anthropic
        env:
          ANTHROPIC_API_KEY: ${{ secrets.ANTHROPIC_API_KEY }}
```

## 12. Data model

### Finding

```ts
type Severity = "critical" | "high" | "medium" | "low" | "info";
type Category = "bug" | "security" | "test_gap" | "performance" | "maintainability";

interface Finding {
  id: string;
  agent: "code_review" | "test_coverage" | "security" | "final_review";
  category: Category;
  severity: Severity;
  confidence: number; // 0.0 to 1.0
  title: string;
  filePath?: string;
  startLine?: number;
  endLine?: number;
  evidence: string;
  impact: string;
  recommendation: string;
  suggestedTest?: string;
  sourceCommitSha: string;
}
```

### Review result

```ts
interface ReviewResult {
  pullRequestNumber: number;
  headSha: string;
  status: "completed" | "partial" | "skipped" | "failed";
  findings: Finding[];
  coverage: {
    status: "measured" | "not_available" | "skipped";
    changedLineCoverage?: number;
    observations: string[];
  };
  skippedFiles: Array<{ path: string; reason: string }>;
  agentRuns: Array<{ agent: string; status: string; durationMs: number }>;
}
```

## 13. Success metrics

| Metric | MVP target |
|---|---|
| Workflow completion rate | At least 95% of eligible PR runs finish with a result. |
| Median review duration | Under 5 minutes for configured PR-size limits. |
| Actionable finding rate | At least 70% of posted inline findings are marked useful/accepted during pilot feedback. |
| False-positive rate | Under 20% for posted inline findings during pilot feedback. |
| Duplicate-comment rate | Under 2% of runs create duplicate findings for the same commit. |
| Review coverage | At least 90% of eligible PRs receive a summary. |

## 14. MVP delivery scope

### In scope

- TypeScript GitHub Action distributed as an internal action or repository package.
- Pull-request event handling and manual re-run option.
- Claude and OpenAI provider adapters.
- Orchestrator plus code-review, test-coverage, and security agents.
- JSON-schema validation, deduplication, and confidence/severity thresholds.
- Inline review comments, one maintained summary comment, and Check Run output.
- Node.js/TypeScript-aware test discovery and optional LCOV ingestion.
- Safe fork-PR behaviour and least-privilege permissions.
- Unit tests for core modules and GitHub API mocks.

### Deferred after MVP

- Auto-generated patch files or one-click fixes.
- Custom web dashboard and organisation-wide reporting.
- Persistent database / historical analytics.
- Fine-tuned or self-hosted models.
- Language-specific deep analysis for Java, Python, Go, PHP, Rust, and mobile platforms.
- Automatic execution of arbitrary repository tests beyond the existing CI workflow.
- Native integration with Jira, Slack, Linear, or other team tools.

## 15. Acceptance criteria

1. Opening or updating an eligible PR triggers the Action exactly once per configured workflow event.
2. The Action posts one structured summary containing code-review, test, and security status.
3. A valid high-confidence issue on a changed line appears as an inline GitHub Pull Request Review comment with a file/line reference and recommendation.
4. Low-confidence or informational observations do not create inline comments under default configuration.
5. The Action identifies missing test scenarios in a controlled fixture PR and labels them as suggestions rather than verified coverage failures when no report exists.
6. When a supported LCOV report is present, the summary reports coverage availability and the changed-line or changed-file coverage result where calculable.
7. A critical/high-confidence security fixture produces a security finding in the summary and Check Run.
8. Invalid model output, a timeout, or a single-agent failure results in a safe partial/neutral result rather than an unhandled workflow crash.
9. Fork PRs never receive access to API secrets or write-token execution by default.
10. Re-running on the same head SHA does not duplicate the bot summary or inline findings.
11. Configured ignored/generated/lock files are excluded from AI prompts and reported as skipped where relevant.
12. `fail_on_threshold` fails the Check Run only when a finding satisfies the configured severity and confidence threshold.

## 16. Risks and mitigations

| Risk | Mitigation |
|---|---|
| False positives reduce trust | Require evidence and structured output; use confidence thresholds, a final validation step, deduplication, and pilot tuning. |
| PR comments become noisy | Limit inline comments, maintain one updated summary, and suppress style-only/duplicate observations. |
| Large diffs exceed model context or cost limits | Enforce size limits, prioritize changed critical files, chunk context, and post a transparent limited-review notice. |
| Prompt injection in repository content | Treat all repository text as untrusted; delimit it, restrict agent capabilities, and validate all outputs before actions. |
| Secret exposure | Filter secrets/sensitive paths, use GitHub secrets only, and do not run privileged workflows on untrusted forks. |
| Model outages / rate limits | Use timeouts, retries with backoff, provider-specific error handling, and partial-result status. |
| Security suggestions are mistaken for a scanner guarantee | Use explicit advisory wording and allow integration with established SAST/dependency tools. |

## 17. Open decisions requiring owner input

1. **Distribution:** Is this intended for one private organisation/repository first, or as a public reusable GitHub Action/Marketplace product?
2. **MVP language scope:** Should the first release support only Node.js/TypeScript repositories, or must it properly support Python, PHP, Java, Go, or another stack from day one?
3. **Execution policy:** Should every PR update receive the full review automatically, or should reviews run only through a label/manual command to control API cost?
4. **Enforcement:** Should the default remain comment-only, or should high/critical findings block merging through a required Check Run?
5. **Coverage source:** Which test tooling/report formats must be supported first (for example Jest/Vitest LCOV, JUnit, Codecov, or none)?
6. **Security tooling:** Is AI-only security review sufficient for MVP, or must CodeQL, Semgrep, npm audit, or Dependabot results be incorporated immediately?
7. **Provider policy:** Will the initial release permit both Anthropic and OpenAI, and is there any restriction on sending private repository code to these providers?

## 18. Recommended next step

Confirm the seven open decisions above. After that, convert this PRD into a technical design containing the workflow event model, module interfaces, configuration schema, GitHub permission strategy, model prompts, and implementation milestones.
