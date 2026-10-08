# User guide

For people who use the platform: install the GitHub App, sign in, add a provider key, configure a repository, read a review and give feedback. If you run the service yourself, start with [self-hosting.md](self-hosting.md); if you manage a team's repositories, [admin-guide.md](admin-guide.md) has the configuration reference.

## What it does

When a pull request is opened or updated, the App reviews it with up to three AI agents:

- **Code review**: bugs, risky changes, maintainability.
- **Test coverage**: changed code without tests, and, if your CI uploads a coverage report, how much of the changed lines is covered.
- **Security**: weaknesses the change introduces, and risky changes to `package.json`.

You get **inline comments** on the lines that matter (only high-confidence findings), **one summary comment** that is updated in place, and a **Check Run** called `AI PR Review` on the pull request. Every run is kept in a dashboard with its findings, so you can see history, rate findings and watch the trends. The review is advice from an AI model: it can be wrong, and it does not replace a human reviewer or your scanners ([security](../README.md#security-review)).

The App reads pull requests through the GitHub API. It never checks out or runs your code.

## 1. Install the App

1. Open the **Install the GitHub App** link on the dashboard sign-in page (or `github.com/apps/<app name>`). Your operator tells you the name.
2. Choose the account or organisation, then **Only select repositories** and pick the ones you want reviewed. (You need to be an owner of the organisation, or the owner of the account.)
3. Nothing is reviewed until a provider key has been added (step 3). A pull request opened before that appears in the dashboard as a failed run that says the key is missing; re-run it once a key is added.

## 2. Sign in

Open the dashboard and choose **Sign in with GitHub**. The dashboard shows only the repositories you can access on GitHub, with your role: an **organisation owner or repository admin is an admin** (can change settings and keys, re-run and cancel), anyone else with access is a **viewer** (can read everything and rate findings).

If the App is installed but you do not see the repository, sign in again: the list is read at sign-in and refreshed within ten minutes of a change on GitHub. If the App is not installed on anything you can reach, the dashboard shows an **Install the GitHub App** page instead.

## 3. Add a provider key (admins)

Reviews use **your** key with the AI provider you choose: DeepSeek, Anthropic or OpenAI (or an OpenAI-compatible endpoint). The platform pays for nothing.

1. Open **Repos**, choose the repository, then **Settings**. (To use one key for every repository of the organisation, open **Account**, choose the installation's **settings** and add the key there; a repository's own key wins over it.)
2. Under **Provider and model** choose the provider and type the model name your provider documents.
3. Paste the key and choose **Test connection**. The test sends one tiny request and tells you whether the provider accepted the key.
4. Save. The key is stored encrypted and is **write-only**: afterwards the dashboard shows only the provider and the last four characters. To change it, enter a new one; to remove it, delete it.

> **Privacy.** A review sends the changed code, file paths and the pull request title and description to the provider you chose. With DeepSeek that is a hosted API operated by a China-based company; choose another provider if that is not acceptable. [privacy.md](privacy.md) lists exactly what is sent and stored, and for how long.

## 4. Configure a repository (admins)

The defaults work for most repositories: automatic review of pull requests into `main` or `master`, comments only (a finding never fails the check), at most 40 files and 120,000 characters of changes, 20 inline comments.

Change them in **Settings** of the repository, or commit a `.github/ai-pr-review.yml` to the repository (the dashboard shows which keys the file sets and locks them). Every key is explained in [admin-guide.md](admin-guide.md#configuration-reference); the example is [examples/ai-pr-review.yml](../examples/ai-pr-review.yml).

Two things worth knowing at once:

- The file is read from the **base branch** of each pull request, so a pull request cannot change how it is reviewed.
- The provider, the model and the limits can only be set in the dashboard, never in the file.

## 5. Read a review

### On the pull request

- **Inline comments** are the findings the review is confident about, each with the problem, why it matters, the evidence and a recommendation. They come in one GitHub review, so you get one notification, not one per comment.
- The **summary comment** lists everything: what was reviewed, findings by severity (including those that were not posted inline), the Security block, coverage, previous findings that are now resolved or still apply, files that were left out and why, and warnings. It is the same comment on every push; it is edited, not repeated.
- The **Check Run** shows the same in short. It is `success` when the review finished, `neutral` when it could not finish or was only partly posted, and `failure` only if an administrator chose `fail_on_threshold` and a finding reached the threshold. A failing check blocks merging only if the repository lists it as a required check.
- A **draft** pull request gets the summary only. A **fork** pull request is skipped unless an admin opted in.

**Re-run a review:** comment `/ai-review` on the pull request (repository owners, members and collaborators only), or choose **Re-run** on the Check Run, or use **Re-run** on the run in the dashboard. Pushing a new commit starts a new review and cancels the one in progress.

### In the dashboard

| Screen | What it shows |
|---|---|
| **Repos** | Your repositories, your role, the latest run of each. |
| **Runs** | Every review, newest first, live: a new pull request shows as _queued_ within seconds and changes status without a refresh. Filter by repository, status, branch, author or severity; the filters are in the address, so you can share a view. |
| **Run detail** | The timeline (queued, started, finished), the commit, the agents and what each did, findings, warnings, files that were skipped and why, how many findings were suppressed and for what reason, token use, and the coverage and security panels. |
| **Pull request history** | All reviews of one pull request in order, with which findings are new, still apply or were resolved. |
| **Findings** | Every finding across your repositories, filterable by severity, category, agent, status (posted, summary only, suppressed), path and date. |
| **Analytics** | Completion, duration, actionable and false-positive rates, duplicates, summary coverage, findings over time and an estimated cost, each against its target and with the sample size beside it. |
| **Account** | Who you are, the installations you can reach and your role in each, with links to the installation's defaults, usage and (for admins) its audit log. Sign out. |

A status other than _completed_ always has a reason. **Skipped**: a draft, a fork, a pull request that is too large, a disabled repository, a quota. **Partial**: one agent failed or timed out; the rest is posted. **Failed**: nothing could be reviewed, for example the key is missing or the provider is down; the reason says which. **Superseded**: a newer commit replaced it. **Cancelled**: someone cancelled it.

## 6. Give feedback

Open a finding (from the run, the Findings screen or the link in the summary) and choose:

- **Useful**: you acted on it, or it caught something real.
- **False positive**: it is wrong.
- **Already known**: right, but you knew.

You may add a short note (only you see it). One vote per person per finding; voting again replaces it. Feedback is what the Analytics screen uses to compute the **actionable** and **false-positive** rates, so it is how the team learns whether the review is worth keeping and where to tune it. A finding the review dropped (suppressed) cannot be rated, and the analytics count votes on findings that were posted inline.

## 7. Everyday problems

| You see | Likely reason | What to do |
|---|---|---|
| No review on a new pull request | The repository is disabled, the pull request is a draft or from a fork, targets another branch than `target_branches`, or a quota was reached. | Open **Runs**: there is a _skipped_ run with the reason. |
| Run _failed_: "no provider key" | No key for this repository or installation. | An admin adds one (step 3). |
| Run _skipped_: too large | More than the file or character limit. | Split the pull request, or an admin raises `max_changed_files` / `max_patch_characters`. |
| Coverage "not measured" | CI uploaded no LCOV artifact for this commit, or was still running. | See [admin-guide.md](admin-guide.md#coverage-from-ci); re-run when CI finishes. |
| The check is red | `fail_on_threshold` is on and a finding reached the threshold. | Fix the finding, or ask an admin; a human can still merge unless the check is required. |
| You cannot see a repository | You lack access on GitHub, or the cache has not refreshed. | Sign in again; changes reach the dashboard within ten minutes. |

More: [admin-guide.md](admin-guide.md#troubleshooting).
