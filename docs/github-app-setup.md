# GitHub App setup (development)

How to register a development GitHub App, receive its webhooks on your machine, install it on a sandbox repository and check that a pull request produces a run. Design: `design.md` §4. Phase: `phases/phase-03-github-app-and-webhooks.md`.

You need a GitHub account (or an organization you own), the repo running locally (`npm run db:up`, `npm run db:migrate`) and Node.js 24.

## 1. What the App needs

Exactly this, nothing more (design §4):

| Setting            | Value                                                                                                                                  |
| ------------------ | -------------------------------------------------------------------------------------------------------------------------------------- |
| Repository permissions | Metadata: read · Contents: read · Pull requests: **read & write** · Checks: **read & write** · Actions: read (coverage artifacts, Phase 11) |
| Subscribe to events | `pull_request`, `issue_comment`, `check_run`. (`installation` and `installation_repositories` are always delivered to an App.)        |
| Webhook URL        | Where GitHub can reach `POST /webhooks/github` (step 2)                                                                                |
| Webhook secret     | A random string, the same value as `GITHUB_WEBHOOK_SECRET`                                                                             |
| Webhook content type | `application/json` (the api rejects `application/x-www-form-urlencoded`)                                                               |
| Callback URL       | `http://localhost:3000/auth/github/callback` (used by dashboard sign-in in Phase 4)                                                    |
| Where installable  | "Only on this account" is fine for development                                                                                         |

## 2. Get webhooks to your machine

GitHub cannot reach `localhost`. Forward a public URL to the api with either tool:

**smee.io (simplest).** Open <https://smee.io>, click "Start a new channel" and keep the channel URL, then run the client:

```bash
npx smee-client --url https://smee.io/<your-channel> --target http://localhost:3000/webhooks/github
```

**A tunnel** (ngrok, cloudflared, …) that forwards `https://<name>.<tunnel-domain>` to `localhost:3000`; the webhook URL is `https://<name>.<tunnel-domain>/webhooks/github`.

Anything sent to a smee channel is readable by whoever knows the URL. Use it for development only, with a sandbox repository, and never for private code.

## 3. Register the App

### Option A: the script (recommended)

```bash
npm run github-app:register -- --webhook-url https://smee.io/<your-channel>
```

Open the printed `http://127.0.0.1:8787/` page, confirm the App on GitHub, and return to the terminal. The script uses GitHub's [App manifest flow](https://docs.github.com/apps/sharing-github-apps/registering-a-github-app-from-a-manifest) with the permissions and events above, exchanges the one-time code for the App's credentials and writes them to `.env.github-app` (git-ignored, owner-only). Copy the five `GITHUB_*` values into `.env`. Useful options: `--name`, `--org <slug>` (create under an organization), `--api-url`, `--port`, `--out`.

### Option B: by hand

GitHub → Settings → Developer settings → GitHub Apps → New GitHub App. Fill in the table above, generate a **private key** (a `.pem` download) and note the **App ID**, **Client ID** and a **client secret**. Put them in `.env`:

```bash
GITHUB_APP_ID=123456
GITHUB_WEBHOOK_SECRET=<the webhook secret you typed>
# One line, double quotes, literal \n between lines (or paste the PEM over several lines in quotes):
GITHUB_APP_PRIVATE_KEY="-----BEGIN RSA PRIVATE KEY-----\nMIIE...\n-----END RSA PRIVATE KEY-----"
GITHUB_CLIENT_ID=Iv1....
GITHUB_CLIENT_SECRET=...
```

The api refuses to start without `GITHUB_APP_ID`, `GITHUB_APP_PRIVATE_KEY` and `GITHUB_WEBHOOK_SECRET`; it names the missing ones and never prints values. A private key that is not valid PEM is rejected at startup the same way.

## 4. Sandbox repository (closes decision 8)

1. Create a private repository you do not mind experimenting in, e.g. `<you>/ai-pr-review-sandbox`, with a `main` branch and a small `src/` file or two.
2. Install the App on **only that repository**: `https://github.com/apps/<app-slug>/installations/new` → "Only select repositories" → the sandbox.
3. Write down the repository and installation in `docs/decision-log.md` (decision 8: sandbox repository `<owner>/<name>`) once it exists.

## 5. Run and verify

```bash
npm run dev                    # api on :3000 (plus worker and web)
npx smee-client --url https://smee.io/<your-channel> --target http://localhost:3000/webhooks/github
```

1. Installing the App sends an `installation` event: the installation and the repository appear in `installations` and `repositories`.
2. Open a pull request from a branch to `main` on the sandbox. Within a few seconds:
   - a `review_runs` row exists with `status = 'queued'` and a `check_run_id`;
   - the PR shows an **AI PR Review** check in the "queued" state;
   - `webhook_deliveries` has the delivery with outcome `run_queued`.
3. Push another commit to the PR: the first run becomes `superseded`, a new `queued` run appears.
4. Comment `/ai-review` on the PR (as the repository owner/collaborator): a new run with trigger `comment_command`.
5. Open a PR from a fork (or use the fork fixture below): a `skipped` run with the reason, no Check Run.

```bash
psql "$DATABASE_URL" -c "select pr_number, left(head_sha,7) sha, status, status_reason, check_run_id from review_runs order by queued_at desc limit 5"
```

Runs stay `queued` until the worker exists (Phase 8); that is expected.

Recent deliveries, with the payload and our response, are also under the App's **Advanced** tab on GitHub; "Redeliver" resends one with the same delivery ID (a duplicate; the api answers `{"status":"duplicate"}`, unless the first attempt failed, in which case it is processed again).

## 6. Replaying webhooks without GitHub

`scripts/replay-webhook.mjs` posts a saved payload with a valid signature, so you can exercise the endpoint without opening PRs:

```bash
npm run webhook:replay -- fixtures/webhooks/installation.created.json
npm run webhook:replay -- fixtures/webhooks/pull_request.opened.json
npm run webhook:replay -- fixtures/webhooks/pull_request.opened.json --set action=synchronize --set pull_request.head.sha=4444444444444444444444444444444444444444
npm run webhook:replay -- fixtures/webhooks/pull_request.fork.json         # skipped: fork
npm run webhook:replay -- fixtures/webhooks/pull_request.opened.json --bad-signature   # 401
npm run webhook:replay -- fixtures/webhooks/pull_request.opened.json --delivery fixed-id # run twice: duplicate
```

It reads `GITHUB_WEBHOOK_SECRET` and `PORT` from `.env`. The event name comes from the file name (`pull_request.opened.json` → `pull_request`) or `--event`. Options are listed at the top of the script. Saved real payloads (copy one from the App's "Recent deliveries" page) work too, as long as the repository and installation in them are ones you have installed.

The fixtures in `fixtures/webhooks/` use installation `1001` and repository `acme/widgets` (`2001`). The fake `acme/widgets` installation is created by replaying `installation.created.json` first, or by the first pull request event (an installation or repository we have never seen is created from the signed payload).

Note: the queued Check Run is created through the GitHub API with the App's credentials. Against a fake installation (as in the fixtures) that call fails; the run is still created and records a warning. A real installation is needed to see the check on a PR.

## Troubleshooting

| Symptom                                          | Likely cause                                                                                                       |
| ------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------ |
| Every delivery is `401`                          | `GITHUB_WEBHOOK_SECRET` differs from the App's webhook secret, or a proxy rewrites the body.                       |
| `415 Unsupported Media Type`                     | The App's webhook content type is `application/x-www-form-urlencoded`; switch to `application/json`.             |
| Deliveries arrive but no run appears             | Check `webhook_deliveries.outcome`: `ignored:*` says why (draft, wrong action, inactive repository, …). A `skipped` run carries its reason in `status_reason`. |
| Run created but no Check Run on the PR           | The run's `warnings` mention it; usually the App lacks "Checks: read & write", or the installation has not accepted new permissions. |
| `/ai-review` does nothing                        | Only `OWNER`, `MEMBER` or `COLLABORATOR` may use it; the comment must start with `/ai-review`; edited comments do not count. |
| The api exits at start naming `GITHUB_APP_*`     | The variable is missing or empty in `.env`.                                                                        |
