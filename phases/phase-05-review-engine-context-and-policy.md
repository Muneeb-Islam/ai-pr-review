# Phase 5 – Review Engine: Context & Policy

**Depends on:** Phase 1 (can run in parallel with Phases 3–4)  
**Unblocks:** Phases 7, 11, 12  
**Refs:** FR-06–FR-10, FR-17, AC-11, design §6, §10

## Goal

In `packages/core`, collect exactly the PR context a review needs through the GitHub API, and guarantee that unsafe, irrelevant or oversized content is removed before any model sees it. No checkout, no filesystem, no database.

## Tasks

### Context collection (FR-06)
- [ ] `collectContext({ octokit, repo, prNumber, config, signal })` returns a typed `ReviewContext` (design §10).
- [ ] Fetch PR title, body, author, draft state, base/head refs and SHAs, fork status, changed files with patches (paginated). Treat files with no `patch` (too large or binary) as skipped with a reason.
- [ ] Fetch existing review comments and the App's earlier summary/fingerprints for lifecycle handling (`prior`).
- [ ] Read `.github/ai-pr-review.yml` from the **base branch at the base SHA**, never from the PR head; validate with the repo-config schema; ignore sensitive keys with a warning; merge with dashboard config (design §6). Invalid file → warning and fall back to dashboard config.

### Diff parsing
- [ ] Parse patches into hunks; map every added line to its new-file line number and diff position.
- [ ] `isLineInDiff(path, line)` for validation and publishing (FR-17).
- [ ] Handle renames, deletions, additions, multiple hunks and `\ No newline at end of file`.

### Nearby code context (FR-07)
- [ ] Fetch surrounding lines or the enclosing function via the contents API at the head SHA, only when needed and within limits.

### Exclusions and secrets (FR-08, FR-10, AC-11)
- [ ] Default excludes: binary, generated, lockfiles, vendored dependencies, build output; merge with config `ignore`.
- [ ] Exclude files matching secret patterns (`.env*`, `*.pem`, `*.key`, credential files) plus `secret_paths`.
- [ ] Redact high-confidence secret formats (API keys, private-key blocks, bearer tokens) in included diffs.
- [ ] Record each skipped file with a reason in `skippedFiles`.

### Size policy (FR-09)
- [ ] Enforce `max_changed_files` and `max_patch_characters`; prioritise source and tests over docs and config; set `limits.status` to `ok`, `limited` or `skipped` with an explanation.
- [ ] Token estimation helper so Phase 6 can budget requests.

### Test discovery (feeds Phase 11)
- [ ] List the repository tree at the head SHA through the git trees API; find JS/TS test files (`*.test.*`, `*.spec.*`, `__tests__/`, `test/`); map changed source files to likely tests by naming and path convention.

## Testing

- Fixture patches covering additions, deletions, renames, multi-hunk and binary files.
- Ignored, lock, generated and secret-pattern files never appear in the context (AC-11); an injected fake secret never appears in any prompt payload.
- Oversized PR gives `limited` or `skipped` with an explanation.
- Repo file read from the base ref; a fork PR that edits the file in its head has no effect.
- Octokit mocked: pagination, missing patches, 404 on config file.

## Deliverables

- `collectContext()`, diff utilities, filters, redaction, size policy and test discovery with fixtures.

## Exit criteria

- All fixture tests pass, including AC-11 behaviour.
- No code path can add an environment value or token to the context.

## Risks

- Over-aggressive redaction hides the bug under review; restrict it to high-confidence formats.
- GitHub API volume per run; fetch only what is needed and respect the throttling plugin.
