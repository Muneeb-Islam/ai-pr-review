# Release notes: v1.0.0

> **Draft. v1.0.0 is not released.** The Phase 16 exit criteria are not met: nothing has run against a real GitHub App, repository or AI provider, and the pilot has not been done ([pilot.md](pilot.md) says exactly what remains). Do not tag until the checklist at the end is complete. When it is, replace this banner with the release date and fill in the measured numbers.

AI PR Review is a GitHub App that reviews pull requests with AI agents, keeps every run in PostgreSQL and shows them in a web dashboard. You bring your own AI provider key.

## What is in it

- **Reviews on the pull request.** One inline review with the findings the agents are confident about, one summary comment that is edited in place, and an `AI PR Review` Check Run (`queued` → `in_progress` → `completed`). Re-running the same commit adds no duplicate comments. A push supersedes the review in progress.
- **Three agents.** Code review; test coverage (suggested tests from the diff, and measured changed-line coverage from an LCOV artifact your CI uploads); security (weaknesses a change introduces, and risky `package.json` changes). An optional final review checks each finding against the diff before it is posted. The security review is advisory and does not replace a scanner.
- **Providers.** DeepSeek, Anthropic and OpenAI (and an OpenAI-compatible endpoint) behind one interface, with retries, timeouts, cancellation, request and token budgets and a concurrency cap per run.
- **Enforcement.** `comment_only` (default), `warn` and `fail_on_threshold`. A failing check blocks a merge only if the repository requires it. A review that did not finish never fails the check.
- **Dashboard.** Sign in with GitHub; repositories; live runs (a new pull request shows as pending within seconds); run detail with agents, findings, warnings, skipped files and usage; pull request history with resolved and still-applicable findings; a findings explorer with feedback (useful, false positive, already known); analytics against the product targets with sample sizes; settings, write-only provider keys with a connection test, an audit log, CSV export, re-run and cancel.
- **Multi-tenant by design.** Installations are isolated in the application and again by PostgreSQL row-level security; provider keys are stored encrypted (envelope encryption, rotation and emergency revocation documented); webhooks are signature-checked, idempotent and rate-limited; quotas and queue limits stop runaway usage and leave a visible skipped run; fork pull requests are skipped unless an admin opts in, and are capped when they are; the platform never checks out or runs repository code.
- **Operable.** A production Docker Compose stack with non-root images and secrets as files, health and readiness checks, `/metrics` and alert rules, backup and restore with a drill, upgrade and rollback, recovery runbooks, retention, and chaos checks (kill a worker, destroy Redis or PostgreSQL).

## Known limitations

- **Not yet proven on real services.** The automated suite uses a mock provider and an in-memory GitHub. Prompt quality, real review duration, false-positive rate and what GitHub accepts for review positions are to be measured in the pilot. No recorded real-provider runs are kept yet ([fixtures/recorded](../fixtures/recorded/README.md)).
- **Coverage depends on your CI.** If the LCOV artifact is not uploaded by the time the review runs, the review says so and you re-run it (`/ai-review`). Re-evaluating automatically when CI finishes (`workflow_run`) is not built.
- **Reviews read the diff.** The agents see changed lines, their context, file paths and the pull request text. They do not read other source files of the repository (the reader for nearby code exists but is not wired in; the Test Coverage agent also reads test names and the coverage report), so a bug that depends on code outside the diff can be missed or guessed at.
- **JavaScript and TypeScript first.** Other text files are reviewed by prompt only, with no language-specific analysis.
- **GitHub.com only.** GitHub Enterprise Server is not supported.
- **Cost figures are estimates.** The analytics page prices tokens from a placeholder table, and [costs.md](costs.md) is derived from request sizes, not from bills.
- **Feedback is explicit.** 👍/👎 reactions on comments are not read; votes are given in the dashboard.
- **Accessibility** is checked automatically (axe in light and dark, keyboard, phone width); nobody has yet used the dashboard with a screen reader.
- **One provider per repository** at a time, with one key per provider per installation or repository.
- **AI output can be wrong.** Findings are filtered, validated and positioned against the diff, but they remain advice from a model.

## Deferred (not in v1)

Billing and a platform-paid key; Git hosts other than GitHub.com and GitHub Enterprise Server; auto-fix patches; approving or merging pull requests; deeper analysis for languages other than JavaScript and TypeScript; scanner adapters beyond the interface (`ScannerAdapter` is defined, none is built); SSO/SAML and custom roles; mobile apps; Slack, Jira and Linear integrations; the post-v1 backlog from the pilot (to be written from [pilot.md](pilot.md) section 8).

## Upgrading

This is the first release. Databases created while it was developed upgrade in place: every earlier schema is tested with data in it (`packages/db/src/upgrade.test.ts`). Back up first ([operations.md](operations.md#12-upgrade-and-rollback)).

## Support and feedback

_To be decided by the owner before the release is announced; this is the one section only the owner can write._ The platform needs, at a minimum: an address or issue tracker for users to report problems and give feedback; a named owner and on-call contact ([operations.md section 1](operations.md#1-ownership-support-and-escalation)); and a place for the post-v1 backlog. Put the real addresses here and in your copy of the [user guide](user-guide.md).

## Release checklist

- [ ] Phase 16 pilot done; [pilot.md](pilot.md) section 5's table filled; every missed target has a fix or an owner-approved exception written down.
- [ ] Sandbox check ([pilot.md](pilot.md) section 2) ticked; the Phase 3, 4, 6, 7, 9, 10, 11 and 12 owner steps done.
- [ ] Recorded real-provider runs committed; `RECORDINGS_MUST_BE_FRESH=1 npm test` passes.
- [ ] `npm run check`, `npm run test:chaos` and `bash scripts/ops/smoke.sh` pass on `main`; `npm audit --audit-level=high` is clean.
- [ ] Someone other than the author self-hosted from [self-hosting.md](self-hosting.md) ([pilot.md](pilot.md) section 7).
- [ ] The price table (`apps/api/src/analytics/pricing.ts`) and DeepSeek model names checked against the providers' current documentation.
- [ ] Versions set to `1.0.0` (root and every workspace `package.json`, then `npm install` to update the lock file), [CHANGELOG.md](../CHANGELOG.md) dated, this page's banner replaced.
- [ ] `git tag v1.0.0`; images built and tagged with `VERSION=v1.0.0` (`docker compose -f docker-compose.prod.yml build`); migration from the previous schema checked on a restored copy of a real database.
- [ ] Support and feedback channel written above.
