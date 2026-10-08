# Admin guide

For people who administer the review of an organisation's repositories: organisation owners and repository admins. (The person who runs the platform itself is the _operator_ and has [operations.md](operations.md); [self-hosting.md](self-hosting.md) is the way in.) Day-to-day use is in the [user guide](user-guide.md).

## Who can do what

| | Viewer | Admin |
|---|---|---|
| See repositories, runs, findings, analytics | yes | yes |
| Rate findings | yes | yes |
| Change settings, add or remove provider keys, test a key | | yes |
| Re-run or cancel a run, export CSV, read the audit log | | yes |
| Enable or disable a repository | | yes |

Your role comes from GitHub: an owner of the organisation or an admin of the repository is an admin; everyone else with access is a viewer. For a personal account the owner is the only admin. Access is re-checked at least every ten minutes, so removing someone on GitHub removes their dashboard access within that time. Every change an admin makes (settings, keys, re-runs) is written to the **audit log** with who, what and when; it records which keys changed, never their values.

## Configuration reference

The effective configuration of a review is built in layers; a later layer wins, key by key:

1. Built-in defaults.
2. The installation's defaults (dashboard: **Account → settings**), for every repository of the organisation.
3. The repository's own settings (dashboard: **Repos → Settings**).
4. `.github/ai-pr-review.yml`, read from the **base branch** of the pull request.

A key set by the file is shown locked in the dashboard. The file may not set the **dashboard-only** keys (`provider`, `model`, `base_url`, `limits`): the file's value is ignored and a warning on the run says so. This is deliberate: a contributor must not be able to send the code somewhere else or raise the spending by editing a file in a pull request. Unknown keys are errors, not silently ignored; an editor with the [JSON Schema](../packages/shared/schemas/ai-pr-review.schema.json) (see the first line of the [example](../examples/ai-pr-review.yml)) will point them out.

### Dashboard only

| Key | Default | Meaning |
|---|---|---|
| `provider` | none (required) | `deepseek`, `openai` or `anthropic`. |
| `model` | none (required) | The provider's model name, as the provider documents it (names change; check before you rely on one). |
| `base_url` | provider's own | An OpenAI-compatible endpoint, for self-hosted or proxied models. Public HTTPS only; private, loopback and link-local addresses are refused, and the name is resolved again on every use. |
| `limits.concurrency` | 3 | Model requests in flight at once for one run. |
| `limits.max_requests` | 20 | Model requests one run may make. |
| `limits.max_total_tokens` | 400,000 | Tokens one run may use, counting requests in flight. |
| `limits.request_timeout_ms` | 120,000 | One request's time limit. |

A run that reaches a limit stops asking the model, posts what it has and says so; it does not run away. Provider **keys** are not configuration: they are stored encrypted, write-only, per installation or per repository.

### Dashboard or file

| Key | Default | Meaning |
|---|---|---|
| `review.mode` | `comment_only` | What a finding does to the Check Run. See [Enforcement](#enforcement-and-required-checks). |
| `review.target_branches` | `[main, master]` | Pull requests into other branches are skipped (and shown as skipped). |
| `review.draft_behavior` | `summary_only` | `summary_only` (summary, no inline comments), `full`, or `skip`. |
| `review.minimum_severity` | `medium` | Findings below this severity are dropped: they are counted as suppressed on the run and posted nowhere. One of `critical`, `high`, `medium`, `low`, `info`. |
| `review.minimum_confidence` | `0.8` | Findings the agent is less sure of than this are dropped the same way. A missing-test suggestion becomes an inline comment only at 0.9 or more and when tied to a changed line; otherwise it stays in the summary. |
| `review.max_changed_files` | 40 | A larger pull request is reviewed for the first files (source first, then tests, then configuration, then documentation) and the summary lists what was left out; one more than five times over a limit is skipped. |
| `review.max_patch_characters` | 120,000 | The same, for the size of the changes. |
| `review.max_inline_comments` | 20 | At most this many inline comments in one review; the rest go to the summary. |
| `agents.code_review` | `true` | The code review agent. |
| `agents.test_coverage` | `true` | Test gaps and, with a CI artifact, measured coverage. |
| `agents.security` | `true` | Security weaknesses and risky `package.json` changes. Advisory: not a scanner. |
| `agents.final_review` | `false` | A second pass that checks each proposed finding against the diff and rejects unsupported ones. Costs an extra model pass per run; switch it on only if the false-positive rate calls for it. |
| `coverage.artifact_name` | `coverage` | Name of the Actions artifact holding the LCOV report. |
| `coverage.lcov_path` | `lcov.info` | Path of the LCOV file inside the artifact. |
| `fork_prs` | `skip` | `skip` or `review`. See [Fork pull requests](#fork-pull-requests). |
| `ignore` | `dist/**`, `coverage/**`, `**/*.lock` | Globs of files that are not sent to the model. Lock files, generated and vendored files, build output and binaries are always left out, whatever this says. |
| `secret_paths` | `**/.env*` | Globs of files treated as secrets, added to the built-in patterns (keys, certificates, `.env`). They are never sent and are shown as skipped. |
| `instructions` | empty | Extra guidance for the reviewers ("we use Result types, not exceptions"). Treated as untrusted text: it cannot change the output format, the provider or the limits. |

## Enforcement and required checks

`review.mode` decides what the Check Run says about findings. A finding **meets the threshold** when its severity is at least `review.minimum_severity` **and** its confidence is at least `review.minimum_confidence`; a missing test never counts.

| Mode | Finding at the threshold | No such finding |
|---|---|---|
| `comment_only` (default) | check is `success`; the finding is a comment | `success` |
| `warn` | check is `neutral` | `success` |
| `fail_on_threshold` | check is `failure` | `success` |

A review that did not finish (failed, skipped, superseded, cancelled) is always `neutral`: an outage or a missing key never blocks a merge. A partial review that did find something at the threshold fails in `fail_on_threshold`, because the finding stands whatever else went wrong.

**A failing check blocks a merge only if the repository requires it.** In GitHub: _Settings → Branches_ (or _Rules → Rulesets_) → require status checks → add `AI PR Review`. Without that, the red mark is information and a human can still merge. Start with `comment_only`, look at the false-positive rate for a few weeks, then move to `warn` or `fail_on_threshold` only where the findings have earned it.

## Fork pull requests

A pull request from a fork is **skipped by default** and shown as a skipped run saying why. The platform never checks out or runs the fork's code, and the provider key never reaches code that handles the fork's data, so reviewing a fork is technically safe. What remains is cost abuse and prompt injection by strangers, so it is opt-in (`fork_prs: review`) and stricter when on: at most 15 files, 40,000 characters, 8 inline comments, 8 requests and 120,000 tokens per pull request, whatever the other limits say, and the installation's quotas apply. These caps are not settings.

## Coverage from CI

The Test Coverage agent never runs your tests. It reads an LCOV file that **your CI uploads as an Actions artifact** for the pull request's head commit. The App needs the **Actions: read** permission (it is in the recommended permission set).

1. In the workflow that runs your tests, produce LCOV and upload it ([examples/upload-coverage.yml](../examples/upload-coverage.yml)):

   ```yaml
   - run: npx vitest run --coverage --coverage.reporter=lcov # or: npx jest --coverage --coverageReporters=lcov
   - uses: actions/upload-artifact@v4
     with:
       name: coverage # coverage.artifact_name
       path: coverage/lcov.info # stored as lcov.info (coverage.lcov_path)
       if-no-files-found: error
   ```

2. If you used other names, set `coverage.artifact_name` and `coverage.lcov_path`.
3. CI often finishes after the review starts. The review then says "CI was still running"; re-run it (`/ai-review`, the Check Run's **Re-run**, or the dashboard) when CI is done.

Without a report the review says coverage could not be measured and **suggests** tests from reading the diff, labelled as suggestions, never as measured coverage.

## Keys, quotas and cost

- A **repository key** wins over the **installation key** for the same provider. Remove a key and the repository falls back to the installation's.
- The operator sets per-installation daily quotas (by default 200 runs and 2,000,000 tokens per UTC day) and queue limits. A run over a limit is recorded as **skipped** with the reason (`quota_exceeded`, `queue_limit`), visible in the dashboard. **Account → settings** shows today's usage.
- Spending is bounded per run by `limits.*` and per day by the quota, with your own provider key. [costs.md](costs.md) has typical sizes and estimated ranges; **Analytics** shows tokens and an estimated cost (an estimate, not a bill).
- Finished runs and their findings are deleted after the retention window (90 days by default; shown, not editable, in the dashboard). **Export CSV** (admin, per repository, up to 20,000 rows) keeps a copy before then.

## Troubleshooting

Always start at **Runs**: a pull request that was not reviewed has a run, and its status and reason say why.

| Symptom | Cause | Fix |
|---|---|---|
| Nothing appears for a new pull request | The webhook did not arrive or was rejected. | On GitHub: _App settings → Advanced → Recent deliveries_. `202` is good; `401` means the webhook secret differs from the platform's; no deliveries means the webhook URL or the "Subscribe to events" list is wrong (pull request, issue comment, check run, installation, installation repositories). Redeliver from there. |
| Run _failed_: no provider key | No key stored for this repository or the installation. | Add one (**Settings**). Then **Re-run**. |
| Run _failed_: the provider refused the key or the model | Wrong key, a model name the provider does not have, or a quota or billing problem at the provider. | **Test connection**; check the model name against the provider's documentation. |
| Run _skipped_: too large | Far above `max_changed_files` or `max_patch_characters`. | Split the pull request, or raise the limits knowingly (cost grows with size). |
| Run _partial_ with a size note | Slightly above a limit: the first files were reviewed and the rest are listed in the summary. | As above, or accept. |
| Run _partial_ with an agent warning | One agent timed out, hit a limit or returned output that failed validation twice. The other agents' results are posted. | Re-run. If it repeats on one agent, look at the provider's status, `limits.request_timeout_ms` and the model. |
| Run _skipped_: draft, fork, branch, repository disabled | Settings did what they say. | Change `draft_behavior`, `fork_prs`, `target_branches`, or enable the repository. |
| Summary posted but no inline comments | Everything was below the confidence or severity threshold, or the pull request is a draft, or GitHub refused the positions (the summary then lists those findings and a warning says so). | Lower `minimum_confidence` carefully; look at the run's _suppressed_ counts. |
| Warning: "could not post" / permission denied | The App lacks a permission, or the installation is suspended. | Compare the App's permissions with the table in [operations.md](operations.md#4-the-production-github-app); accept the permission request GitHub sent to the organisation owner. |
| Coverage "not measured" | No artifact for this commit, wrong name or path, expired artifact, Actions permission missing. | [Coverage from CI](#coverage-from-ci); the run's coverage panel names the reason. |
| The check is red but no one wants it to be | `fail_on_threshold` and a finding at the threshold. | Rate the finding a false positive, raise the threshold, or switch the mode. |
| Dashboard shows old repository access | The access cache (up to ten minutes). | Wait, or sign in again. |
| Run stays _queued_ | Workers are down or busy, or Redis lost the job. | Operator: [operations.md](operations.md#11-recovery-runbooks). The sweeper re-queues lost jobs on its own within a minute or two. |

When you report a problem to the operator, give the run's address (its id): it contains no code, and the logs are keyed by it.
