// Manual smoke test: one trivial request to a real provider (Phase 6). Costs a few tokens.
//
//   PROVIDER=deepseek MODEL=deepseek-flash PROVIDER_API_KEY=... npm run provider:smoke
//   (optional: PROVIDER_BASE_URL=https://...)
//
// This script, not the package, reads the environment. The key is never printed.
import { createLogger } from "@ai-pr-review/shared";
import { createProvider, testConnection, type ProviderName } from "../src";

const name = process.env["PROVIDER"] as ProviderName | undefined;
const model = process.env["MODEL"];
const apiKey = process.env["PROVIDER_API_KEY"];
const baseUrl = process.env["PROVIDER_BASE_URL"];

if (!name || !model || !apiKey) {
  console.error("Set PROVIDER (deepseek|openai|anthropic), MODEL and PROVIDER_API_KEY.");
  process.exit(2);
}

const provider = createProvider({
  name,
  model,
  apiKey,
  baseUrl,
  logger: createLogger({}),
});

const connection = await testConnection(provider);
console.log(connection.message);
if (!connection.ok) process.exit(1);

const result = await provider.complete({
  system: "You are a code reviewer. Answer briefly.",
  user: "Does `if (x = 1)` in JavaScript compare x with 1? Answer with a verdict and a one-sentence reason.",
  jsonSchema: {
    type: "object",
    properties: { verdict: { enum: ["yes", "no"] }, reason: { type: "string" } },
    required: ["verdict", "reason"],
    additionalProperties: false,
  },
  maxOutputTokens: 200,
  timeoutMs: 60_000,
});
console.log(JSON.stringify(result, null, 2));
