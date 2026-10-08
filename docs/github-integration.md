# Connecting the project to GitHub

A complete, step-by-step guide: what GitHub needs, what the project needs, and how to join the two. Written for someone doing this for the first time.

For the short technical reference see [github-app-setup.md](github-app-setup.md). For production see [operations.md](operations.md) (sections 3 and 4).

## Contents

1. [How the connection works](#1-how-the-connection-works)
2. [What you need before you start](#2-what-you-need-before-you-start)
3. [What the GitHub App needs](#3-what-the-github-app-needs)
4. [Step 1: Start the project](#4-step-1-start-the-project)
5. [Step 2: Make your computer reachable](#5-step-2-make-your-computer-reachable)
6. [Step 3: Create the GitHub App](#6-step-3-create-the-github-app)
7. [Step 4: Fill in the `.env` file](#7-step-4-fill-in-the-env-file)
8. [Step 5: Create a test repository and install the App](#8-step-5-create-a-test-repository-and-install-the-app)
9. [Step 6: Sign in to the dashboard](#9-step-6-sign-in-to-the-dashboard)
10. [Step 7: Add your AI provider key](#10-step-7-add-your-ai-provider-key)
11. [Step 8: Open a pull request and see the review](#11-step-8-open-a-pull-request-and-see-the-review)
12. [Optional: test coverage from CI](#12-optional-test-coverage-from-ci)
13. [Going to production](#13-going-to-production)
14. [Checklist](#14-checklist)
15. [Troubleshooting](#15-troubleshooting)

---

## 1. How the connection works

The project talks to GitHub in **three ways**. All three come from one thing: a **GitHub App**.

| Direction | What happens | Used for |
|---|---|---|
| GitHub → project | GitHub sends a **webhook** (an HTTP request) to `POST /webhooks/github`. | Telling the project that a pull request was opened or updated. |
| Project → GitHub | The project signs in **as the App** with its private key and calls the GitHub API. | Reading the diff, posting comments, creating the Check Run. |
| You → project | You click **Sign in with GitHub** (OAuth) on the dashboard. | Knowing who you are and which repositories you may see. |

```
 You open a pull request
        │
        ▼
 GitHub ──webhook──► API (verifies the signature, creates a run)
                      │
                      ▼
                    Worker ──GitHub API (as the App)──► reads the diff
                      │                                  posts comments + Check Run
                      └──────────► AI provider (your key)
```

A **GitHub App** is better than a personal access token because it has its own identity, only the permissions you choose, and is installed on **specific repositories**.

## 2. What you need before you start

**Accounts**

- A GitHub account (or an organization you own).
- An API key from one AI provider: **DeepSeek**, **Anthropic** or **OpenAI**.

**On your computer**

- Node.js 24 or newer and npm.
- Docker with Docker Compose.
- A way to expose your local API to the internet, because GitHub cannot reach `localhost`. Either [smee.io](https://smee.io) (free, simplest) or a tunnel such as ngrok or cloudflared.

**Use a test repository.** Create a private repository you do not mind experimenting in. Do not point a development setup at private company code.

## 3. What the GitHub App needs

Give the App exactly this and nothing more.

### Repository permissions

| Permission | Level | Why |
|---|---|---|
| Metadata | Read | Required by GitHub for every App. |
| Contents | Read | Read the changed files and the base branch's `.github/ai-pr-review.yml`. |
| Pull requests | **Read & write** | Read the diff, post inline comments and the summary comment. |
| Checks | **Read & write** | Create and update the `AI PR Review` Check Run. |
| Issues | Read | GitHub requires it to deliver the `issue_comment` event (the `/ai-review` command). |
| Actions | Read | Download the LCOV coverage artifact from CI. Optional: without it, coverage is reported as "could not be measured". |

### Organization permission

| Permission | Level | Why |
|---|---|---|
| Members | Read | Tells an organization owner from a member, so owners can manage installation-wide settings and keys. Optional. |

### Webhook events to subscribe to

- `pull_request`: a pull request is opened, updated, reopened or marked ready.
- `issue_comment`: the `/ai-review` command.
- `check_run`: the "Re-run" button on the Check Run.

`installation` and `installation_repositories` are always sent to an App. You do not need to select them.

### Other settings

| Setting | Value |
|---|---|
| Webhook URL | A public URL that reaches `POST /webhooks/github` (see step 2). |
| Webhook secret | A random string. It must equal `GITHUB_WEBHOOK_SECRET` in `.env`. |
| Webhook content type | `application/json`. The API rejects `application/x-www-form-urlencoded`. |
| Callback URL | `http://localhost:3000/auth/github/callback` in development. It must equal `${API_PUBLIC_URL}/auth/github/callback`. |
| Expire user authorization tokens | Keep **on**. The project uses the user's token once, at sign-in, and never stores it. |
| Where can this App be installed | "Only on this account" is fine for development. |

### Credentials GitHub gives you

| Value | `.env` variable |
|---|---|
| App ID | `GITHUB_APP_ID` |
| Private key (`.pem` file) | `GITHUB_APP_PRIVATE_KEY` |
| Webhook secret (you choose it) | `GITHUB_WEBHOOK_SECRET` |
| Client ID | `GITHUB_CLIENT_ID` |
| Client secret | `GITHUB_CLIENT_SECRET` |

Treat the private key, the client secret and the webhook secret like passwords. Never commit them.

## 4. Step 1: Start the project

```bash
npm install
cp .env.example .env
npm run db:up        # PostgreSQL and Redis in Docker
npm run db:migrate   # create the tables
```

Do not run `npm run dev` yet. The API refuses to start until the GitHub values are in `.env`.

## 5. Step 2: Make your computer reachable

GitHub must be able to send webhooks to your machine.

### Option A: smee.io (simplest)

1. Open <https://smee.io> and click **Start a new channel**.
2. Copy the channel URL, for example `https://smee.io/AbC123`.
3. You will start the forwarder in step 8:

```bash
npx smee-client --url https://smee.io/AbC123 --target http://localhost:3000/webhooks/github
```

> Anyone who knows a smee URL can read what passes through it. Use it only with a test repository.

### Option B: a tunnel (ngrok, cloudflared)

Forward a public HTTPS address to `localhost:3000`. Your webhook URL is then `https://<your-tunnel-domain>/webhooks/github`.

## 6. Step 3: Create the GitHub App

### Option A: with the script (recommended)

The script sends the correct permissions and events to GitHub for you, so you cannot forget one.

```bash
npm run github-app:register -- --webhook-url https://smee.io/AbC123
```

1. Open the page it prints: `http://127.0.0.1:8787/`.
2. GitHub opens and asks you to confirm the App. Click **Create GitHub App**.
3. Go back to the terminal. The credentials are saved in **`.env.github-app`** (git-ignored).

Useful options:

| Option | Meaning |
|---|---|
| `--name "My Reviewer"` | App names are unique across GitHub. Use this if "AI PR Review (dev)" is taken. |
| `--org my-org` | Create the App under an organization. |
| `--api-url https://...` | Public URL of the API, if it is not `http://localhost:3000`. |

### Option B: by hand

1. GitHub → **Settings** → **Developer settings** → **GitHub Apps** → **New GitHub App**.
2. Fill in the name and a homepage URL (any URL).
3. **Webhook**: tick **Active**, enter the webhook URL and a webhook secret you invent (for example from `openssl rand -hex 32`). Remember the secret.
4. **Callback URL**: `http://localhost:3000/auth/github/callback`. Keep **Expire user authorization tokens** ticked.
5. **Permissions**: set the permissions from [section 3](#3-what-the-github-app-needs).
6. **Subscribe to events**: tick `Pull request`, `Issue comment` and `Check run`.
7. **Where can this GitHub App be installed?** Choose "Only on this account".
8. Click **Create GitHub App**.
9. On the App's page, note the **App ID** and **Client ID**.
10. Click **Generate a new client secret** and copy it right away. It is shown once.
11. Scroll to **Private keys** and click **Generate a private key**. A `.pem` file downloads.

## 7. Step 4: Fill in the `.env` file

Open `.env`. If you used the script, copy the `GITHUB_*` lines from `.env.github-app`. Then fill in:

```bash
# GitHub App
GITHUB_APP_ID=123456
GITHUB_WEBHOOK_SECRET=the-secret-you-set-on-the-app
GITHUB_CLIENT_ID=Iv1.abc123
GITHUB_CLIENT_SECRET=...
# One line, in double quotes, with \n between the lines of the .pem file:
GITHUB_APP_PRIVATE_KEY="-----BEGIN RSA PRIVATE KEY-----\nMIIE...\n-----END RSA PRIVATE KEY-----"

# Where things live (development defaults)
PUBLIC_URL=http://localhost:5173
API_PUBLIC_URL=http://localhost:3000

# Two secrets you generate yourself
SESSION_SECRET=...   # openssl rand -base64 48
ENCRYPTION_KEY=...   # openssl rand -base64 32
```

> **Back up `ENCRYPTION_KEY`.** It protects the AI provider keys stored in the database. If you lose it, those keys cannot be read again and must be entered again.

If a variable is missing, the app stops at startup and lists only the **names** of the missing variables, never their values.

## 8. Step 5: Create a test repository and install the App

1. On GitHub, create a **private** repository, for example `ai-pr-review-sandbox`, with a `main` branch and a few small source files.
2. Open `https://github.com/apps/<your-app-slug>/installations/new`.
3. Choose **Only select repositories** and select the test repository.
4. Click **Install**.

Now start everything:

```bash
npm run dev        # API (3000), worker, dashboard (5173)
```

In a second terminal, start the webhook forwarder (if you use smee):

```bash
npx smee-client --url https://smee.io/AbC123 --target http://localhost:3000/webhooks/github
```

Installing the App sends an `installation` event. The installation and the repository now appear in the database, and in the dashboard after you sign in.

## 9. Step 6: Sign in to the dashboard

1. Open <http://localhost:5173>.
2. Click **Sign in with GitHub** and authorize the App.
3. You should see your test repository in the list.

Your access is read from GitHub at sign-in and re-checked every 10 minutes. You only see repositories you can reach on GitHub. Only repository admins can change settings or keys.

## 10. Step 7: Add your AI provider key

1. In the dashboard open your repository, then **Settings**.
2. Choose a **provider** (DeepSeek, Anthropic or OpenAI) and a **model**.
3. Paste your **API key** and click **Test connection**. This sends one tiny request to the provider.
4. Save.

The key is encrypted before it is stored. After saving, only the provider and the last four characters are ever shown.

> If you choose DeepSeek, code from reviewed pull requests is sent to DeepSeek's hosted API. See [privacy.md](privacy.md).

## 11. Step 8: Open a pull request and see the review

1. In the test repository, create a branch, change some code and open a pull request into `main`.
2. Within a few seconds:
   - the pull request shows an **AI PR Review** check as *queued*;
   - the dashboard shows a new run, *pending*, then *running*;
   - when done, the pull request gets inline comments, one summary comment, and the check turns green or reports its result.
3. Push another commit. The old run is marked *superseded* and a new run starts. The summary comment is updated, not duplicated.
4. Comment `/ai-review` on the pull request to run it again. This works for owners, members and collaborators.

**Not ready to use real GitHub yet?** Send a saved webhook to your local API:

```bash
npm run webhook:replay -- fixtures/webhooks/pull_request.opened.json
```

Because that installation is fake, the Check Run cannot be created, but the run itself still appears.

## 12. Optional: test coverage from CI

The Test Coverage agent never runs your tests. It reads an LCOV report that **your own CI uploads** as a GitHub Actions artifact. The App needs the **Actions: read** permission for this.

Add this to the workflow that runs your tests (full example: [../examples/upload-coverage.yml](../examples/upload-coverage.yml)):

```yaml
- run: npx vitest run --coverage --coverage.reporter=lcov
- uses: actions/upload-artifact@v4
  with:
    name: coverage
    path: coverage/lcov.info
    if-no-files-found: error
```

If CI is still running when the review starts, the review says so. Re-run it with `/ai-review` once CI finishes.

## 13. Going to production

Use a **separate** GitHub App for production. Do not reuse the development one.

| Setting | Development | Production |
|---|---|---|
| Webhook URL | smee.io or tunnel | `https://your-domain/webhooks/github` |
| Callback URL | `http://localhost:3000/auth/github/callback` | `https://your-domain/auth/github/callback` |
| `API_PUBLIC_URL` / `PUBLIC_URL` | localhost | Your real HTTPS URLs |
| Secrets | `.env` file | Real secret storage, never committed |
| Run with | `npm run dev` | `docker-compose.prod.yml` |

Full instructions: [self-hosting.md](self-hosting.md) and [operations.md](operations.md).

## 14. Checklist

- [ ] GitHub App created with the permissions and events from section 3
- [ ] Webhook URL is reachable and the content type is `application/json`
- [ ] Webhook secret on GitHub equals `GITHUB_WEBHOOK_SECRET`
- [ ] Callback URL equals `${API_PUBLIC_URL}/auth/github/callback`
- [ ] `.env` has the App ID, private key, client ID and client secret
- [ ] `SESSION_SECRET` and `ENCRYPTION_KEY` generated, and `ENCRYPTION_KEY` backed up
- [ ] App installed on the test repository
- [ ] `npm run dev` is running, and the forwarder is running if you use smee
- [ ] Signed in to the dashboard and the repository is listed
- [ ] AI provider key saved and **Test connection** succeeded
- [ ] A pull request produced a run, comments and a Check Run

## 15. Troubleshooting

| Problem | Likely cause and fix |
|---|---|
| The API exits at startup naming `GITHUB_APP_*` | A variable is missing or empty in `.env`. |
| Every webhook gets `401` | `GITHUB_WEBHOOK_SECRET` differs from the App's webhook secret, or a proxy changed the body. |
| Webhooks get `415` | The App's content type is `application/x-www-form-urlencoded`. Change it to `application/json`. |
| Webhook sent but no run appears | Check the App's **Advanced → Recent deliveries** on GitHub. In the database, `webhook_deliveries.outcome` says why it was ignored (draft pull request, wrong action, inactive repository). |
| Run exists but no Check Run on the pull request | The App lacks **Checks: read & write**, or the installation has not accepted the new permissions. Open the installation settings and accept them. |
| `/ai-review` does nothing | Only owners, members and collaborators can use it. The comment must start with `/ai-review`. Edited comments do not count. |
| Sign-in fails with `invalid_state` | The sign-in took over 10 minutes or the cookie was lost. Start again from the login page. |
| Sign-in fails with a callback error | The callback URL on GitHub does not match `${API_PUBLIC_URL}/auth/github/callback`. |
| Repository missing in the dashboard | The App is not installed on it, or you have no access to it on GitHub. |
| Cannot change settings or keys | You need admin rights on the repository. In an organization, installation-wide settings need the **Members: read** permission. |
| Pull request from a fork gets no review | Intended. Fork pull requests are skipped unless you opt in, and never receive secrets. |
| Coverage "could not be measured" | CI has not uploaded the `coverage` artifact yet, or the App lacks **Actions: read**. |
| Key test fails | Wrong provider, wrong key, or no credit on the provider account. |

Still stuck? Send a test event with `npm run webhook:replay` to check whether the problem is on the GitHub side (delivery) or in the project (handling).
