// Load test for webhook bursts (Phase 15): sends N signed pull_request events, as GitHub would, to a running api and reports
// how the platform answered. Every event is a different pull request of one installation, so each should become a run.
//
//   node scripts/ops/load-webhooks.mjs --url http://localhost:8080/webhooks/github --secret-file secrets/github_webhook_secret
//   node scripts/ops/load-webhooks.mjs --url ... --secret ... --count 200 --concurrency 20 --installation 999001
//
// Afterwards compare with the database:   select status, count(*) from review_runs where pr_number >= 900000 group by status;
// The payloads create their own installation and repository (999001) on first sight, so it works against an empty stack.
// The reviews themselves will fail on a stack with made-up GitHub credentials; what is measured is acceptance and queueing.
import { createHmac } from "node:crypto";
import { performance } from "node:perf_hooks";
import { readFileSync } from "node:fs";

const args = process.argv.slice(2);
const option = (name, fallback) => {
  const at = args.indexOf(`--${name}`);
  return at >= 0 && args[at + 1] ? args[at + 1] : fallback;
};

const url = option("url", `http://localhost:${process.env.PORT || 3000}/webhooks/github`);
const secretFile = option("secret-file");
const secret = option(
  "secret",
  secretFile ? readFileSync(secretFile, "utf8").trim() : process.env.GITHUB_WEBHOOK_SECRET,
);
const count = Number(option("count", "200"));
const concurrency = Number(option("concurrency", "20"));
const installation = Number(option("installation", "999001"));
if (!secret) {
  console.error("No secret: pass --secret, --secret-file or set GITHUB_WEBHOOK_SECRET.");
  process.exit(2);
}

const FIRST_PR = 900_000;
const payloadFor = (n) => ({
  action: "opened",
  number: FIRST_PR + n,
  pull_request: {
    number: FIRST_PR + n,
    draft: false,
    head: {
      sha: (n.toString(16).padStart(8, "0") + "a".repeat(40)).slice(0, 40),
      ref: `feature-${n}`,
      repo: { full_name: "load-test/widgets" },
    },
    base: { sha: "b".repeat(40), ref: "main", repo: { full_name: "load-test/widgets" } },
    user: { login: "load-tester" },
  },
  repository: {
    id: installation,
    full_name: "load-test/widgets",
    name: "widgets",
    private: false,
    default_branch: "main",
    owner: { login: "load-test", id: 1, type: "Organization" },
  },
  installation: { id: installation },
  sender: { login: "load-tester" },
});

async function send(n) {
  const body = JSON.stringify(payloadFor(n));
  const started = performance.now();
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-github-event": "pull_request",
        "x-github-delivery": `load-${installation}-${n}`,
        "x-hub-signature-256": `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`,
      },
      body,
    });
    await res.text();
    return { status: res.status, ms: performance.now() - started };
  } catch {
    return { status: 0, ms: performance.now() - started };
  }
}

const results = [];
let next = 0;
const startedAll = performance.now();
await Promise.all(
  Array.from({ length: concurrency }, async () => {
    while (next < count) results.push(await send(next++));
  }),
);
const seconds = (performance.now() - startedAll) / 1000;

const byStatus = {};
for (const r of results) byStatus[r.status] = (byStatus[r.status] ?? 0) + 1;
const times = results.map((r) => r.ms).sort((a, b) => a - b);
const pct = (p) => times[Math.min(times.length - 1, Math.floor((p / 100) * times.length))] ?? 0;

console.log(
  `${results.length} events in ${seconds.toFixed(1)} s (${(results.length / seconds).toFixed(0)} per second, concurrency ${concurrency})`,
);
console.log(
  `answers: ${JSON.stringify(byStatus)}  (202 = accepted; 429 = rate limited; 0 = no answer)`,
);
console.log(
  `latency: p50 ${pct(50).toFixed(0)} ms, p95 ${pct(95).toFixed(0)} ms, max ${times.at(-1)?.toFixed(0)} ms`,
);
const accepted = byStatus[202] ?? 0;
if (accepted !== count) {
  console.error(`FAIL: ${count - accepted} of ${count} events were not accepted.`);
  process.exit(1);
}
console.log("All events accepted. Check the runs in the database (see the header of this file).");
