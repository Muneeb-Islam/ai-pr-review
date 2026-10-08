// Manual prompt check (Phases 7 and 12): sends the fixture pull requests of the Code Review agent, or with
// AGENT=security those of the Security agent, to a real provider and compares what comes back with what each
// fixture expects. This is how the prompts in `src/prompts/codeReview.v1.ts` and `security.v1.ts` are tuned. It
// costs a few thousand tokens per fixture.
//
//   PROVIDER=deepseek MODEL=deepseek-flash PROVIDER_API_KEY=... npm run review:fixtures
//   AGENT=security PROVIDER=deepseek MODEL=deepseek-flash PROVIDER_API_KEY=... npm run review:fixtures
//   (optional: PROVIDER_BASE_URL=https://..., FIXTURE=name to run one, VERBOSE=1 to list every finding)
//
// With RECORD=1 each fixture's real answers are also written to fixtures/recorded/ as a regression fixture
// (packages/core/src/agents/recordings.ts, docs/pilot.md "Tuning"); commit the files that change.
//
// This script, not the package, reads the environment. The key is never printed.
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createLogger } from "@ai-pr-review/shared";
import { createProvider, type ProviderName } from "../src";
import { REVIEW_FIXTURES } from "../src/agents/codeReview/fixtures";
import { recordFixture, recordingFileName } from "../src/agents/recordings";
import { SECURITY_FIXTURES } from "../src/agents/security/fixtures";

const name = process.env["PROVIDER"] as ProviderName | undefined;
const model = process.env["MODEL"];
const apiKey = process.env["PROVIDER_API_KEY"];
const baseUrl = process.env["PROVIDER_BASE_URL"];
const only = process.env["FIXTURE"];
const security = process.env["AGENT"] === "security";
const verbose = Boolean(process.env["VERBOSE"]);
const record = Boolean(process.env["RECORD"]);
const RECORDED = fileURLToPath(new URL("../../../fixtures/recorded/", import.meta.url));

if (!name || !model || !apiKey) {
  console.error("Set PROVIDER (deepseek|openai|anthropic), MODEL and PROVIDER_API_KEY.");
  process.exit(2);
}

const provider = createProvider({ name, model, apiKey, baseUrl, logger: createLogger({}) });
const fixtures = (security ? SECURITY_FIXTURES : REVIEW_FIXTURES).filter(
  (f) => !only || f.name === only,
);
if (fixtures.length === 0) {
  console.error(`No fixture named ${only}.`);
  process.exit(2);
}

let hits = 0;
let expectedTotal = 0;
let falseAlarms = 0;
let failedRuns = 0;

for (const fixture of fixtures) {
  const { result, recording } = await recordFixture(
    fixture,
    security ? "security" : "code_review",
    provider,
  );
  const { found, expected, extra } = recording.outcome;
  hits += found;
  expectedTotal += expected;
  falseAlarms += extra;
  if (result.status === "failed") failedRuns += 1;

  const mark = found === expected && extra === 0 && result.status !== "failed" ? "PASS" : "FAIL";
  console.log(
    `${mark} ${fixture.name}: status=${result.status} found=${found}/${expected} extra=${extra} suppressed=${result.suppressed.length} tokens=${result.usage.inputTokens + result.usage.outputTokens}`,
  );
  if (record) {
    const file = join(RECORDED, recordingFileName(recording));
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, `${JSON.stringify(recording, null, 2)}\n`);
    console.log(`   recorded ${file}`);
  }
  if (verbose || mark === "FAIL") {
    for (const f of result.findings) {
      console.log(
        `   ${f.severity} ${f.confidence} ${f.filePath ?? "-"}:${f.startLine ?? "-"} ${f.title}`,
      );
    }
    for (const s of result.suppressed)
      console.log(`   suppressed (${s.reason}): ${s.finding.title}`);
    for (const w of result.warnings) console.log(`   warning: ${w}`);
  }
}

console.log(
  `\nSeeded bugs found: ${hits}/${expectedTotal}. False alarms on the accepted list: ${falseAlarms}. Failed runs: ${failedRuns}.`,
);
process.exit(hits === expectedTotal && falseAlarms === 0 && failedRuns === 0 ? 0 : 1);
