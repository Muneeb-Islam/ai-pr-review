# Changelog

All notable changes to this project. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versions follow [Semantic Versioning](https://semver.org/). The platform and its workspaces share one version; container images are tagged with it (`VERSION` in `.env.production`).

## [Unreleased] (candidate for 1.0.0)

Phase 16 added the proof, the documentation and the release material; the product itself was built in Phases 1 to 15. The version in `package.json` is still `0.1.0` and `v1.0.0` is not tagged: see the release checklist in [docs/release-notes-v1.0.0.md](docs/release-notes-v1.0.0.md).

### Added

- Acceptance suite (`acceptance/`, `npm run acceptance`): the end-to-end story across the api, worker and publisher, the enforcement matrix (AC-12), size-limit and latency checks, and a traceability test that ties AC-1 to AC-23 to named tests and keeps [docs/acceptance.md](docs/acceptance.md) in step.
- Upgrade tests: a database holding data is upgraded from every earlier schema to the latest.
- Recording and replay of real-provider fixture runs (`RECORD=1 npm run review:fixtures`, `fixtures/recorded/`).
- `npm run pilot:report`: the PRD success metrics as counts and percentages with verdicts and token use by size of review.
- Documentation: [user guide](docs/user-guide.md), [admin guide](docs/admin-guide.md), [self-hosting guide](docs/self-hosting.md), [cost notes](docs/costs.md), [validation and pilot plan](docs/pilot.md), release notes, and a rewritten README.

### Changed

- None to the product.

## Earlier development (Phases 1 to 15)

- Phase 1: monorepo foundation; the Action-based review code migrated into workspaces.
- Phase 2: PostgreSQL schema, migrations and tenant-scoped data access.
- Phase 3: GitHub App authentication, verified and idempotent webhooks, queued and skipped runs.
- Phase 4: GitHub sign-in, sessions, CSRF, roles, settings and encrypted provider keys.
- Phase 5: PR context collection, exclusions, secret redaction and size policy.
- Phase 6: DeepSeek, Anthropic and OpenAI behind one provider interface.
- Phase 7: agent framework, finding validation, the Code Review agent.
- Phase 8: BullMQ queue, worker, run lifecycle, quotas and recovery.
- Phase 9: GitHub publisher: inline review, summary comment and Check Run.
- Phase 10: dashboard foundation with live runs.
- Phase 11: Test Coverage agent and LCOV from Actions artifacts.
- Phase 12: Security agent.
- Phase 13: idempotent re-runs, enforcement modes, partial results, previous-finding tracking and the optional final review.
- Phase 14: findings explorer, feedback, settings, analytics, audit log, CSV export, re-run and cancel, retention.
- Phase 15: row-level security, rate limits, fork caps, prompt-injection and canary tests, production Compose, metrics, backup and restore runbooks, chaos checks.
