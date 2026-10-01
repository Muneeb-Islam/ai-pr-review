# Phase 2 – Context Collection & Policy Engine

**Depends on:** Phase 1  
**Unblocks:** Phases 4, 6, 7  
**PRD refs:** FR-06–FR-10, AC-11, NFR Cost control, NFR Privacy

## Goal

Collect exactly the PR context a review needs and guarantee that unsafe, irrelevant or oversized content is removed before any model sees it.

## Scope

In: GitHub data collection, diff parsing, exclusion rules, secret protection, size policy, JS/TS test file discovery.  
Out: calling models, posting output.

## Tasks

### Context collection (FR-06)

- [ ] Fetch PR title, description, base and head SHAs, author, draft status.
- [ ] Fetch changed-file metadata and unified patches via the GitHub API (paginate; handle files with no patch because the diff is too large).
- [ ] Fetch existing review comments and any previous bot summary for later lifecycle handling.
- [ ] Build a typed `ReviewContext` object.

### Diff parsing

- [ ] Parse patches into hunks and map each changed line to its new-file line number and diff position.
- [ ] Expose a lookup `isLineInDiff(path, line)` for Phase 4 and 5 validation (FR-17).
- [ ] Handle renames, deletions, additions, and files with `\ No newline at end of file`.

### Nearby code context (FR-07)

- [ ] Fetch surrounding lines or the enclosing function only when needed to understand a changed line.
- [ ] Respect per-file and total context limits.

### Exclusion rules (FR-08, AC-11)

- [ ] Default excludes: binary files, generated files, lockfiles, vendored dependencies (`node_modules`, `vendor`), build output (`dist/**`, `coverage/**`).
- [ ] Merge with the configured `ignore` globs.
- [ ] Record every skipped file in `skippedFiles` with a reason.

### Secret protection (FR-10)

- [ ] Never include environment variable values, tokens or GitHub Action secrets in any prompt payload.
- [ ] Exclude files matching secret patterns (`.env*`, `*.pem`, `*.key`, credentials files); make patterns configurable.
- [ ] Redact secret-like strings (API keys, private-key blocks, bearer tokens) found inside included diffs.

### Size policy (FR-09)

- [ ] Enforce `max_changed_files` and `max_patch_characters`.
- [ ] When over the limit, prioritise critical files (source and tests over docs and config), then truncate the rest.
- [ ] Produce a status of `completed`, `partial` (limited review) or `skipped`, plus a plain explanation for the summary.
- [ ] Add token estimation helpers so Phase 3 can budget requests.

### Test file discovery (feeds Phase 6)

- [ ] Locate JS/TS test files: `*.test.ts|js`, `*.spec.ts|js`, `__tests__/`, `test/`.
- [ ] Map each changed source file to likely test files by naming and path convention.

## Suggested layout

```
src/context/
  collector.ts       # collectContext()
  diff.ts            # patch parsing and line mapping
  filters.ts         # exclusion rules
  secrets.ts         # secret patterns and redaction
  limits.ts          # size policy
  testDiscovery.ts
```

## Testing

- Fixture patches: additions, deletions, renames, multi-hunk, binary.
- Ignored, lock, generated and secret-pattern files never appear in the output context (AC-11).
- Oversized PR gives a limited or skipped status with an explanation.
- Redaction removes known secret formats without mangling surrounding code.
- Line mapping verified against hand-checked patches.

## Deliverables

- `collectContext()` returning `ReviewContext` and `skippedFiles`.
- Diff line lookup utility.

## Exit criteria

- All fixture tests pass, including AC-11 behaviour.
- No code path can add an env value or token to the context (verified by a test that injects a fake secret).

## Risks

- GitHub omits `patch` for very large files; treat them as skipped with a reason rather than failing.
- Over-aggressive redaction could hide the very bug being reviewed; keep it limited to high-confidence secret formats.
