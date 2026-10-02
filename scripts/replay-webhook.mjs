// Sends a saved webhook payload to a running api with a valid signature, like GitHub would.
// Replaces the old Action-era local-run.mjs. See docs/github-app-setup.md.
//
//   npm run webhook:replay -- fixtures/webhooks/pull_request.opened.json
//   npm run webhook:replay -- fixtures/webhooks/pull_request.opened.json --set pull_request.head.sha=abc123
//   npm run webhook:replay -- payload.json --event issue_comment --url https://my-tunnel.example/webhooks/github
//
// Options
//   --event <name>        X-GitHub-Event. Default: the file name up to the first dot (pull_request.opened.json).
//   --url <url>           Default: http://localhost:$PORT/webhooks/github (PORT defaults to 3000).
//   --secret <secret>     Default: GITHUB_WEBHOOK_SECRET (read from .env by `npm run webhook:replay`).
//   --delivery <id>       X-GitHub-Delivery. Default: a new random ID. Reuse one to test duplicate handling.
//   --set <path=value>    Override a field before sending (repeatable). Dotted path; the value is a string
//                         unless it is true, false, null or starts with { [ ".
//   --set-json <path=json>  Same, with the value parsed as JSON (numbers, arrays).
//   --bad-signature       Send a wrong signature, to see the 401.
import { createHmac, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { basename } from "node:path";

function parseArgs(argv) {
  const opts = { sets: [], file: undefined };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--bad-signature") opts.badSignature = true;
    else if (arg === "--event") opts.event = argv[++i];
    else if (arg === "--url") opts.url = argv[++i];
    else if (arg === "--secret") opts.secret = argv[++i];
    else if (arg === "--delivery") opts.delivery = argv[++i];
    else if (arg === "--set") opts.sets.push({ spec: argv[++i], json: false });
    else if (arg === "--set-json") opts.sets.push({ spec: argv[++i], json: true });
    else if (arg.startsWith("--")) throw new Error(`Unknown option ${arg}`);
    else if (!opts.file) opts.file = arg;
    else throw new Error(`Unexpected argument ${arg}`);
  }
  return opts;
}

function literal(value) {
  if (/^(true|false|null)$/.test(value) || /^[{["]/.test(value)) return JSON.parse(value);
  return value;
}

function setPath(target, path, value) {
  const keys = path.split(".");
  let cur = target;
  for (const key of keys.slice(0, -1)) {
    if (typeof cur[key] !== "object" || cur[key] === null) cur[key] = {};
    cur = cur[key];
  }
  cur[keys.at(-1)] = value;
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (!opts.file) {
    console.error(
      "Usage: npm run webhook:replay -- <payload.json> [--event name] [--url url] [--set path=value]",
    );
    process.exit(2);
  }

  const payload = JSON.parse(readFileSync(opts.file, "utf8"));
  for (const { spec, json } of opts.sets) {
    const at = spec.indexOf("=");
    if (at < 1) throw new Error(`--set expects path=value, got "${spec}"`);
    const value = spec.slice(at + 1);
    setPath(payload, spec.slice(0, at), json ? JSON.parse(value) : literal(value));
  }

  const event = opts.event ?? basename(opts.file).split(".")[0];
  const secret = opts.secret ?? process.env.GITHUB_WEBHOOK_SECRET;
  if (!secret)
    throw new Error("No secret: set GITHUB_WEBHOOK_SECRET (e.g. in .env) or pass --secret.");
  const url = opts.url ?? `http://localhost:${process.env.PORT || 3000}/webhooks/github`;
  const delivery = opts.delivery ?? randomUUID();

  // Sign the exact bytes that are sent: GitHub's signature covers the raw body.
  const body = JSON.stringify(payload);
  const signature = opts.badSignature
    ? `sha256=${"0".repeat(64)}`
    : `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;

  const response = await fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "user-agent": "GitHub-Hookshot/replay",
      "x-github-event": event,
      "x-github-delivery": delivery,
      "x-hub-signature-256": signature,
    },
    body,
  });

  console.log(`${event} delivery ${delivery} -> ${response.status} ${response.statusText}`);
  const text = await response.text();
  if (text) console.log(text);
  if (!response.ok) process.exit(1);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
