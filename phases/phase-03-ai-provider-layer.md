# Phase 3 – AI Provider Layer

**Depends on:** Phase 1 (Phase 2 for token estimation)  
**Unblocks:** Phase 4  
**PRD refs:** FR-15, FR-16, NFR Cost control, NFR Reliability

## Goal

One typed interface over DeepSeek, Anthropic and OpenAI, with retries, timeouts, token budgeting and concurrency limits, so agents never touch provider-specific code. DeepSeek is the primary provider (decision 2); build and smoke-test it first.

## Scope

In: provider interface, two adapters, mock provider, concurrency and budget controls.  
Out: prompts and agent logic (Phase 4).

## Tasks

### Interface (FR-15)

- [ ] Define `Provider` with a method such as `complete({ system, messages, schema, maxTokens, timeoutMs }) → { data, usage }`.
- [ ] Define provider error classes: `ProviderTimeout`, `ProviderRateLimit`, `ProviderUnavailable`, `ProviderAuthError`, `ProviderInvalidResponse`.

### Adapters

- [ ] **DeepSeek adapter (first):** OpenAI-compatible chat completions with a configurable `base_url`, JSON mode, key from `DEEPSEEK_API_KEY`. DeepSeek does not enforce a JSON schema strictly, so describe the schema in the prompt, parse the JSON, and rely on the Phase 4 validator. Confirm current model IDs and JSON-mode behaviour in DeepSeek's docs before writing the example config.
- [ ] Share request and response code between the DeepSeek and OpenAI adapters (OpenAI-compatible base class) so only the base URL, key and structured-output differences live in each.
- [ ] Anthropic adapter: request formatting, structured JSON output (tool-use or JSON schema approach), response parsing.
- [ ] OpenAI adapter: request formatting, structured outputs / JSON mode, response parsing.
- [ ] Log a one-line notice of which provider receives code (privacy; see `docs/decision-log.md`).
- [ ] Use the model identifier from config only; no model names in logic.
- [ ] Use low temperature or deterministic settings where the provider supports them (FR-16).

### Reliability

- [ ] Per-request timeout.
- [ ] Retries with exponential backoff and jitter for 429 and 5xx; no retry on auth or validation errors.
- [ ] Honour `Retry-After` headers.

### Cost and concurrency control (FR-16)

- [ ] Concurrency limiter for model requests (configurable, small default such as 3).
- [ ] Per-run limits on request count and total tokens; stop issuing requests when exceeded and report a partial result.
- [ ] Track usage per request and log estimated tokens and cost to the workflow log only, never to a PR comment by default.

### Configuration and failure modes

- [ ] `createProvider(config)` factory selecting the adapter.
- [ ] Fail fast with a clear message when the matching API key (`DEEPSEEK_API_KEY`, `ANTHROPIC_API_KEY` or `OPENAI_API_KEY`) is missing. Never print the key.
- [ ] Mock provider returning canned responses for tests and offline fixtures.

## Suggested layout

```
src/providers/
  types.ts           # Provider interface, errors
  anthropic.ts
  openai.ts
  factory.ts
  mock.ts
  limiter.ts         # concurrency and budget
```

## Testing

- Mocked HTTP for each adapter: success, malformed JSON, timeout, 429 with `Retry-After`, 5xx then success, 401.
- Limiter respects the concurrency cap and budget cut-off.
- Missing-key path produces the expected error and no network call.
- Manual smoke test against each real provider with a trivial prompt.

## Deliverables

- `createProvider(config)` with Anthropic, OpenAI and mock implementations.

## Exit criteria

- Adapter tests pass for all failure paths above.
- A single code path can call either provider by changing only config.

## Risks

- Structured-output features differ between providers; keep the translation inside each adapter so the agent code stays identical.
- Provider API changes; isolate SDK usage to the adapters and pin SDK versions.
