// Registers a development GitHub App from a manifest (GitHub's "App manifest flow").
// Steps and what to do with the result: docs/github-app-setup.md.
//
//   npm run github-app:register -- --webhook-url https://smee.io/<your-channel>
//
// Options
//   --webhook-url <url>   Required. Where GitHub delivers webhooks (a smee.io channel or a tunnel URL that
//                         forwards to http://localhost:3000/webhooks/github). Also read from WEBHOOK_PROXY_URL.
//   --name <name>         App name (must be unique on GitHub). Default: "AI PR Review (dev)".
//   --org <slug>          Create the App under an organization instead of your personal account.
//   --api-url <url>       Public base URL of the api, for the OAuth callback. Default: http://localhost:3000.
//   --port <n>            Local port for the helper page. Default: 8787.
//   --out <file>          Where to write the credentials. Default: .env.github-app (git-ignored).
//
// The script starts a tiny local server, shows a page that sends the manifest to GitHub, receives the
// redirect with a one-time code and exchanges it for the App's credentials. Nothing is sent anywhere
// except github.com. The credentials are written to --out with owner-only permissions; copy them into
// .env. They are never printed.
import { randomBytes } from "node:crypto";
import { writeFileSync } from "node:fs";
import { createServer } from "node:http";

function parseArgs(argv) {
  const opts = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg.startsWith("--")) throw new Error(`Unexpected argument ${arg}`);
    const value = argv[++i];
    if (value === undefined) throw new Error(`${arg} needs a value`);
    opts[arg.slice(2)] = value;
  }
  return opts;
}

/** Permissions and events: docs/design.md section 4. Nothing else. */
function buildManifest({ name, webhookUrl, apiUrl, redirectUrl }) {
  return {
    name,
    url: "https://github.com",
    hook_attributes: { url: webhookUrl, active: true },
    redirect_url: redirectUrl,
    callback_urls: [`${apiUrl}/auth/github/callback`],
    public: false,
    default_permissions: {
      metadata: "read",
      contents: "read",
      pull_requests: "write",
      // GitHub refuses the issue_comment event (the /ai-review command) without this read permission.
      issues: "read",
      checks: "write",
      actions: "read",
      // Organization permission "Members: read". Lets the dashboard tell an organization owner (admin) from a
      // member. Without it everyone but the owner of a personal account is a viewer on the installation;
      // repository admin rights are unaffected (they come from the repository permission).
      members: "read",
    },
    // `installation` and `installation_repositories` are always delivered to a GitHub App.
    default_events: ["pull_request", "issue_comment", "check_run"],
  };
}

const escapeHtml = (text) =>
  text.replace(
    /[&<>"']/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c],
  );

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const webhookUrl = opts["webhook-url"] ?? process.env.WEBHOOK_PROXY_URL;
  if (!webhookUrl) {
    throw new Error(
      "--webhook-url is required (a smee.io channel or tunnel URL; see docs/github-app-setup.md).",
    );
  }
  const port = Number(opts.port ?? 8787);
  const apiUrl = (opts["api-url"] ?? "http://localhost:3000").replace(/\/$/, "");
  const out = opts.out ?? ".env.github-app";
  const state = randomBytes(16).toString("hex");
  const redirectUrl = `http://127.0.0.1:${port}/callback`;
  const manifest = buildManifest({
    name: opts.name ?? "AI PR Review (dev)",
    webhookUrl,
    apiUrl,
    redirectUrl,
  });
  const target = opts.org
    ? `https://github.com/organizations/${encodeURIComponent(opts.org)}/settings/apps/new`
    : "https://github.com/settings/apps/new";

  const done = new Promise((resolve, reject) => {
    const server = createServer(async (req, res) => {
      const url = new URL(req.url ?? "/", redirectUrl);
      if (url.pathname === "/") {
        res.setHeader("content-type", "text/html; charset=utf-8");
        res.end(`<!doctype html><meta charset="utf-8"><title>Register GitHub App</title>
<form id="f" method="post" action="${escapeHtml(target)}?state=${state}">
  <input type="hidden" name="manifest" value="${escapeHtml(JSON.stringify(manifest))}">
  <p>Sending the App manifest to GitHub. If nothing happens, press the button.</p>
  <button type="submit">Create the GitHub App</button>
</form>
<script>document.getElementById("f").submit()</script>`);
        return;
      }
      if (url.pathname === "/callback") {
        try {
          if (url.searchParams.get("state") !== state)
            throw new Error("State mismatch; start again.");
          const code = url.searchParams.get("code");
          if (!code) throw new Error("GitHub did not send a code.");
          const response = await fetch(
            `https://api.github.com/app-manifests/${encodeURIComponent(code)}/conversions`,
            {
              method: "POST",
              headers: {
                accept: "application/vnd.github+json",
                "user-agent": "ai-pr-review-register",
              },
            },
          );
          if (!response.ok)
            throw new Error(`GitHub answered ${response.status} when exchanging the code.`);
          const app = await response.json();
          const lines = [
            "# Generated by scripts/register-github-app.mjs. Copy these into .env; do not commit.",
            `GITHUB_APP_ID=${app.id}`,
            `GITHUB_APP_SLUG=${app.slug}`,
            `GITHUB_APP_PRIVATE_KEY="${app.pem.trim().replace(/\r?\n/g, "\\n")}"`,
            `GITHUB_WEBHOOK_SECRET=${app.webhook_secret}`,
            `GITHUB_CLIENT_ID=${app.client_id}`,
            `GITHUB_CLIENT_SECRET=${app.client_secret}`,
            "",
          ];
          writeFileSync(out, lines.join("\n"), { mode: 0o600 });
          res.setHeader("content-type", "text/html; charset=utf-8");
          res.end(
            `<!doctype html><meta charset="utf-8"><title>Done</title><p>The App was created. Return to the terminal.</p>`,
          );
          resolve(app);
        } catch (err) {
          res.statusCode = 400;
          res.end("Registration failed; see the terminal.");
          reject(err);
        } finally {
          server.close();
        }
        return;
      }
      res.statusCode = 404;
      res.end();
    });
    server.listen(port, "127.0.0.1", () => {
      console.log(`Open http://127.0.0.1:${port}/ in your browser and confirm the App on GitHub.`);
    });
    server.on("error", reject);
  });

  const app = await done;
  console.log(`\nCreated "${app.name}" (${app.html_url}).`);
  console.log(`Credentials written to ${out} (owner-only). Copy the values into .env.`);
  console.log(
    `Next: install the App on your sandbox repository: https://github.com/apps/${app.slug}/installations/new`,
  );
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
