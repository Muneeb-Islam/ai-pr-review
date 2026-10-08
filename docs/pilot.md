# Validation and pilot

The plan for proving the platform meets its acceptance criteria and success metrics on real repositories, and the record of what has and has not been proven so far. Targets in [scope.md](scope.md) §7 and §8.

> **Status: the pilot has not been run.** What exists is everything that can be proven without a real GitHub App, repository or AI provider: the automated acceptance suite, the platform's own timings, a pilot report tool and recording machinery. Every number in the first section is from the software itself with a mock provider. **No pilot metric (actionable rate, false-positive rate, real review duration) has been measured**, and none of the owner steps below has been done. The exit criteria of Phase 16 are therefore **not met**.

## 1. What is proven by automated tests

`npm run acceptance` runs the Phase 16 suite (`acceptance/`); `npm test` runs it with everything else, and CI runs `npm test` on every change. The suite is a real PostgreSQL, the real api routes, the real worker and publisher, and an in-memory GitHub and mock provider.

| Evidence | Where |
|---|---|
| Every criterion AC-1 to AC-23 has named tests, checked on every run (a renamed or deleted test fails the build) | [acceptance.md](acceptance.md), `acceptance/traceability.test.ts` |
| The whole story: install the App, add a key, open a PR, it shows as pending, the worker reviews it, review, summary and Check Run reach the PR, dashboard history, feedback moves the analytics, re-run is linked and adds no duplicate comment | `acceptance/endToEnd.test.ts` |
| Enforcement: every mode against no finding, a low finding, a finding below the confidence threshold, a finding at it, a missing test, a partial run and every unfinished status (AC-12) | `acceptance/enforcement.test.ts` |
| A PR at the configured limits (40 files, about 118,000 patch characters) is reviewed within the request and token budgets; one over is partial; far over is skipped without a model call | `acceptance/performance.test.ts` |
| Upgrading a database that holds data from every earlier schema reaches the schema a fresh install gets, history intact | `packages/db/src/upgrade.test.ts` |
| Chaos: kill a worker, stop and destroy Redis and PostgreSQL while reviews run; every run ends exactly once | `npm run test:chaos` (weekly and on `main` in CI) |

The platform's own latency, in-process with no network and a local database (`ACCEPTANCE_REPORT=1 npm run acceptance` prints them; measured on a developer laptop, 2026-10-07):

| Target ([scope.md](scope.md) §8) | Measured (60 and 105 samples) | Verdict |
|---|---|---|
| Webhook accepted → run `queued`, p95 < 3 s | p50 17 ms, p95 19 ms | The software adds no delay. Production adds GitHub's delivery time and the network. |
| API reads, p95 < 500 ms | p50 10 ms, p95 15 ms (seeded with 60 runs) | As above. Re-measure with the pilot's data volume. |
| `queued` → `running`, p95 < 30 s at normal load | Not measured here: it depends on worker capacity. | Measure in the pilot (query below). |
| Dashboard reflects a change, < 5 s | The api announces `run.updated` as the status is written and the dashboard updates on it (tested in `useRunEvents.test.tsx` and the Playwright `live.spec.ts`); polling is the fallback. | Confirm by stopwatch in the sandbox check. |

## 2. What only the owner can do

These need accounts and keys the repository does not have. Nothing below is ticked.

- [ ] Register the **development GitHub App**, create and install the **sandbox repository** ([github-app-setup.md](github-app-setup.md)); see a real PR produce a `queued` run (Phase 3 owner step).
- [ ] Sign in with the real App and set a provider key on the sandbox repository (Phase 4).
- [ ] `npm run provider:smoke` against a real provider (Phase 6).
- [ ] `npm run review:fixtures` and `AGENT=security npm run review:fixtures` against a real provider; tune prompts until the fixtures pass (Phases 7 and 12).
- [ ] Upload a coverage artifact from the sandbox repository's CI and open a PR (Phase 11).
- [ ] The M1 demo on the sandbox repository (Phase 9) and the dashboard live check (Phase 10).

### Sandbox check

On the sandbox repository, with the stack running (locally with `npm run dev` and a tunnel, or on a deployed instance), tick each line. It is the real-GitHub part of the acceptance criteria ([acceptance.md](acceptance.md) lists it under each criterion as **Real GitHub**).

- [ ] Install the App on the repository (AC-22 in reverse): an installation and its repository appear in the dashboard.
- [ ] Add a provider key; **Test connection** succeeds; the dashboard never shows the key again (AC-18).
- [ ] Open a PR that adds a seeded bug. With a stopwatch: the **queued** Check Run and a **pending** row in the dashboard within about 5 seconds (AC-16). _Measured: ____ s._
- [ ] One review with an inline comment on the bug's line, one summary comment, the Check Run completed (AC-1, AC-2, AC-3). GitHub accepted the positions.
- [ ] Push a commit while a review runs: the older run is superseded and posts nothing stale (AC-15).
- [ ] Comment `/ai-review`: a new run for the same head adds no duplicate inline comment and edits the same summary (AC-10).
- [ ] Open the PR in the dashboard: run detail, pull request history, the finding. Rate it **Useful**; Analytics changes (AC-19).
- [ ] **Re-run** from the dashboard: a new run linked to the first (AC-21).
- [ ] Open a PR from a fork of the sandbox repository: skipped, with the reason (AC-9).
- [ ] Set `review.mode: fail_on_threshold`, make `AI PR Review` a required check, open a PR with the seeded bug: the check fails and the merge is blocked; with `comment_only` it is not (AC-12).
- [ ] Upload the coverage artifact: the summary reports a measured percentage; without it, "not measured" and labelled suggestions (AC-5, AC-6).
- [ ] Uninstall the App: the dashboard hides the repository; a new PR creates no run (AC-22).
- [ ] Set a tiny daily quota: the next PR is a visible skipped run with the reason (AC-23).

## 3. Performance with a real provider

- [ ] **A PR at the configured limits** (40 files, 120,000 characters). Generate one on a branch of the sandbox repository:

  ```bash
  mkdir -p src/generated && for i in $(seq 1 40); do
    { for n in $(seq 1 40); do echo "export const value_${i}_${n} = compute(${i}, ${n}); // $(printf 'x%.0s' $(seq 1 25))"; done; } > "src/generated/file${i}.ts"
  done
  ```

  (About 3,000 characters of patch per file.) Open it, let it complete **at least five times** (re-run), and read the median in the dashboard (run detail, or the `aipr_run_duration_seconds_24h` metric). Target: **median under 5 minutes**. _Measured: ____._
- [ ] **`queued` → `running` p95 < 30 s at normal load**, from the pilot's runs:

  ```sql
  select percentile_cont(0.95) within group (order by extract(epoch from started_at - queued_at)) as p95_seconds,
         count(*) as runs
    from review_runs where started_at is not null and queued_at > now() - interval '28 days';
  ```

- [ ] **Webhook → `queued` p95 < 3 s**, from the delivery log (this overstates it slightly: `processed_at` is after the run and its Check Run exist):

  ```sql
  select percentile_cont(0.95) within group (order by extract(epoch from processed_at - received_at)) as p95_seconds,
         count(*) as deliveries
    from webhook_deliveries where event = 'pull_request' and processed_at is not null and received_at > now() - interval '28 days';
  ```

- [ ] **Tokens by size class and cost per provider**: `npm run pilot:report` prints them from the pilot's runs. Replace the estimates in [costs.md](costs.md) with the medians and re-check the price table.
- [ ] **Limits stop runaway usage with a real provider**: set `limits.max_requests: 2` on the sandbox repository and review the PR at the limits: the run stops asking, posts what it has and says so.

## 4. Recorded real-provider runs

Real answers are kept as regression fixtures ([fixtures/recorded/README.md](../fixtures/recorded/README.md)). **There are none yet.** Record them once the prompts pass the fixtures:

```bash
RECORD=1 PROVIDER=deepseek MODEL=<model> PROVIDER_API_KEY=... npm run review:fixtures
RECORD=1 AGENT=security PROVIDER=deepseek MODEL=<model> PROVIDER_API_KEY=... npm run review:fixtures
```

Commit the files. From then on `npm test` replays them through the current engine; before a release run `RECORDINGS_MUST_BE_FRESH=1 npm test` to be sure no recording predates the prompts that ship.

## 5. The pilot

**Who and what.** One to three real JavaScript or TypeScript repositories, in `comment_only` mode, installed with the owners' consent and their own provider keys, for **two to four weeks or at least 50 reviewed pull requests**, whichever comes later. Tell the owners what is sent to the provider ([privacy.md](privacy.md)) before installing, and agree where they report problems.

**During the pilot**
- Ask reviewers to rate every inline comment (Useful, False positive, Already known) in the dashboard. The metrics are only as good as the votes.
- Keep a pilot log (a shared document is fine) with one line per event: _date, repository, PR, what happened_, under three headings:
  - **False positives**: findings that were wrong, with the reason (misread code, missing context, style opinion).
  - **Duplicates**: the same point posted twice, on one pull request or across pushes.
  - **Missed**: obvious issues the review did not report. Found by the spot check below, or reported by the owners.

**Spot check.** Once a week, take five finished reviews at random and read the diffs yourself. Write down what a careful human would have flagged and whether the review did. This is what keeps a low false-positive rate honest: it can be reached by suppressing too much, and only missed issues show that. Compare the dashboard's numbers with what you found by hand.

**Report.**

```bash
npm run pilot:report -- --days 28 --provider deepseek
```

prints the table below with counts beside percentages and a verdict per metric, from the same numbers the Analytics screen shows. If a sample is under 10 observations it says so and asks for a longer pilot rather than a verdict; extend the pilot instead of arguing from a small number.

| Metric | Target | Measured |
|---|---|---|
| Workflow completion rate | ≥ 95% | ☐ |
| Median review duration | < 5 min | ☐ |
| Actionable finding rate | ≥ 70% | ☐ |
| False-positive rate | < 20% | ☐ |
| Duplicate-comment rate | < 2% | ☐ |
| Summary coverage | ≥ 90% | ☐ |

A missed target needs either a fix (and a longer pilot) or an **owner-approved exception** written here with the reason and the date.

## 6. Tuning

Change one thing at a time from pilot data: a prompt, a threshold (`minimum_confidence`, `minimum_severity`), or whether the optional final review is on. After **each** change:

1. `npm test` (the acceptance suite and the replay of recorded runs).
2. For a prompt change, record again (section 4) and compare the outcome files in `git diff`: found, extra, suppressed, per fixture. A prompt that finds fewer seeded bugs or adds noise does not ship.
3. Run the next week of the pilot and compare the report. The final review's effect is the difference in false-positive rate and cost with and without it.

Write each change and its effect in [decision-log.md](decision-log.md).

## 7. Self-hosting check

The exit criteria ask that someone other than the author can self-host from the docs alone. Give [self-hosting.md](self-hosting.md) to a person who did not write it, with a clean host and no help. Note every question they ask and every step they stumble on, fix the page, and repeat until they reach a reviewed pull request unaided.

- [ ] Done by: ____, date: ____, questions fixed: ____.

## 8. Findings and decisions

_Empty until the pilot runs. Record here the false-positive, duplicate and missed-issue counts, the tuning decisions and the approved exceptions._
