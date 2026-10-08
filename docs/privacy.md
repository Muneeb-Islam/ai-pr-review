# Privacy: what is sent, what is stored, for how long, and how to delete it

This page is written for the people who install the App and for the operator who runs the platform. It describes what the
code does today; it is not a legal document, and an operator who hosts the platform for others must adapt it (name the
operator, the contact address and the legal basis) before opening it to outsiders. Related: [operations.md](operations.md)
(deleting data, backups), [design.md](design.md) §9 (security model), [scope.md](scope.md) (PL-08).

The platform reads pull requests through the GitHub API with the permissions listed in [design.md](design.md) §4, asks an AI
model to review them, and stores the result so that you can see the history. It never checks out or runs your code.

## 1. What is sent to the AI provider

A review sends a request to **one provider**, the one an administrator chose for the repository (DeepSeek, Anthropic,
OpenAI, or an OpenAI-compatible endpoint the administrator entered). Each request contains:

| Sent                                                                                                            | Detail                                                                                                                                                                                                                      |
| --------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| The **diff** of the changed files that pass the filters below                                                   | Only changed lines and their surrounding context from GitHub's own diff; never a whole file, never a file that is not part of the pull request. Limited to 40 files and 120,000 characters by default (less for fork pull requests). |
| The **paths** of the changed files, and the paths left out with the reason                                      |                                                                                                                                                                                                                             |
| The pull request **title and description**                                                                      | Cut to 300 and 6,000 characters.                                                                                                                                                                                            |
| The review **instructions**                                                                                     | The text an administrator typed in the dashboard and the `instructions` key of `.github/ai-pr-review.yml` on the base branch.                                                                                               |
| For test coverage: **names of tests** related to the changed files, and the measured coverage of changed lines  | Names of test cases and groups of up to six unchanged test files (not their code), and file paths, line ranges and counts from the coverage report.                                                                         |
| For the security review: the **changes to `package.json`**                                                      | Dependencies and scripts that changed.                                                                                                                                                                                      |
| For the optional final review (off by default): the **findings** the other agents produced                     | Titles, places and short excerpts.                                                                                                                                                                                          |

What is **not** sent:

- Files that look like secrets (`.env*`, keys, certificates and anything in your `secret_paths`), binary files, lock files,
  vendored and build-output directories, generated files and anything in your `ignore` list. They are listed as "skipped"
  with the reason, never read by the model.
- Credentials in the text that is sent: GitHub, AWS, Slack, Stripe, Google, npm and `sk-` style keys, JWTs, bearer tokens,
  passwords inside URLs and private-key blocks are replaced by `[REDACTED:<kind>]` before anything leaves the platform.
  Redaction recognises documented formats; it cannot know every secret, so do not rely on it for a secret that is not in
  one of them. The same removal is applied to the model's answer before it is stored or posted.
- Your API keys, the platform's own secrets and tokens, and anything from the server's environment.
- The names of the people involved (the pull request author's login, commit authors, reviewers), commit history, other
  people's comments, and the contents of any file outside the pull request.

**The provider receives your code.** What it does with it is governed by your agreement with that provider, not by this
platform: check its retention and training terms before enabling a repository. The platform logs, without any code,
which provider and host a repository's reviews go to.

### DeepSeek

The hosted DeepSeek API is operated by a company based in China. If you choose DeepSeek, the parts of your pull requests
listed above are processed by that service, under its terms and the laws that apply to it. If your organisation cannot
accept that, choose another provider, or point the repository at a self-hosted OpenAI-compatible endpoint (`base_url`).
The dashboard shows this notice next to the provider choice.

## 2. What the platform stores

Everything is in the PostgreSQL database of the platform. No diff, no source file and no pull request description is stored.

| Stored                                    | Detail                                                                                                                                                                                                                                      |
| ----------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Your GitHub identity**                  | GitHub user id, login and avatar URL, from sign-in. The OAuth token used at sign-in is used once and **never stored**.                                                                                                                      |
| **Sessions**                              | A random id, when it ends and a secret for the CSRF token. One HttpOnly cookie in your browser carries the signed session id.                                                                                                               |
| **Access caches**                         | Which installations and repositories you can see on GitHub and your role in them, refreshed from GitHub within ten minutes of use.                                                                                                         |
| **Installations and repositories**        | Account name, repository full names, whether private, default branch, and whether reviews are enabled.                                                                                                                                      |
| **Settings**                              | The review configuration you saved, including the instructions text.                                                                                                                                                                        |
| **Provider keys**                         | **Encrypted** (AES-256-GCM, a separate data key per key, wrapped by the server's `ENCRYPTION_KEY`) and the last four characters. Keys are write-only: no screen or endpoint returns one.                                                      |
| **Review runs**                           | Pull request number, base branch name, commit hashes, what triggered the run and who (login), status and timing, token counts, the **paths** of skipped files with the reason, warnings, and the measured-coverage summary (paths, ranges, counts). |
| **Findings**                              | Title, file path and lines, a **short excerpt of the code as evidence (at most 500 characters)**, the impact, the recommendation and a suggested test. Secrets and exploit payloads are removed from security findings.                      |
| **Feedback**                              | Your verdict on a finding (useful, false positive, already known) and an optional note, shown only to you.                                                                                                                                  |
| **Audit log**                             | Who changed settings or keys, or re-ran or cancelled a run, when, and on what (never the key itself).                                                                                                                                       |
| **Webhook deliveries**                    | GitHub's delivery id, event name, which installation, and the outcome, so that a redelivered event is not processed twice.                                                                                                                  |
| **Logs** (a file or collector, not the database) | Request lines (route pattern, status, timing) and run lines (repository name, pull request number, status, timings). No code, no keys, no tokens. Keeping and protecting them is the operator's responsibility; 30 days is a sensible limit. |

The dashboard uses no analytics, no advertising and no third-party scripts. The only other site your browser contacts is
GitHub's avatar host. The browser stores your theme choice (light or dark) and nothing else.

## 3. For how long

| Data                                                                     | Kept                                                                                                                                                   |
| ------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Finished runs with their agent runs, findings, comment records, feedback | **90 days** from the run (`RETENTION_DAYS`), then deleted together by a job that runs every six hours. Runs that are still queued or running are not deleted by it. |
| Audit log                                                                | **365 days** (`AUDIT_RETENTION_DAYS`).                                                                                                                 |
| Webhook delivery records                                                 | **14 days** (`WEBHOOK_DELIVERY_RETENTION_DAYS`).                                                                                                       |
| Sessions                                                                 | Until you sign out, after 2 hours without use, or 7 days after sign-in at the latest; expired ones are swept hourly.                                    |
| Access caches                                                            | Replaced at each sign-in; dropped when not refreshed for 30 days.                                                                                      |
| Provider keys                                                            | Until you delete them, or immediately when the App is uninstalled.                                                                                     |
| Installation and everything it owns, after the **App is uninstalled**    | Hidden from the dashboard at once and no run starts; provider keys and access caches are deleted at once; the rest is purged after the retention window (90 days). |
| Installation that is **suspended**                                       | Hidden and idle; nothing is deleted, because suspension can be lifted.                                                                                 |
| **Backups** of the database                                              | As long as the operator keeps them (see [operations.md](operations.md)); deleted data leaves the backups when they expire.                              |

## 4. How to delete your data

- **A provider key:** repository or installation settings, Provider key, Delete. It takes effect for the next review.
- **Everything about an organisation or account:** uninstall the GitHub App. Access stops at once and the data is purged
  after the retention window. To erase it immediately, the operator removes it ([operations.md](operations.md), "Erasing an
  installation now").
- **Your own record** (login, avatar, sessions, cached access, feedback notes): ask the operator, who deletes the `users`
  row; everything that points at it is removed or detached with it.
- **A single run:** there is no per-run delete; runs expire with the retention window.

## 5. Who can see what

A signed-in person sees only the repositories GitHub says they can reach, through the installations of the App. A viewer can
read runs, findings and analytics; changing settings or keys, exporting data, re-running and cancelling need administrator
rights on the repository (or ownership of the organisation) on GitHub. Another account's data is never returned: a request
for it is answered exactly as if it did not exist, and the database itself refuses cross-tenant reads (row-level security).
The operator, who has access to the servers, can read the database; protect that access like any production system.
