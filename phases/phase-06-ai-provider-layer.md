# Phase 6 – AI Provider Layer

**Depends on:** Phase 1 (Phase 5 for token estimation)  
**Unblocks:** Phase 7  
**Refs:** FR-15, FR-16, PL-10, design §9, §10

## Goal

One typed interface over DeepSeek, Anthropic and OpenAI, with retries, timeouts, cancellation, token budgeting and concurrency limits, so agents never touch provider-specific code. DeepSeek is built and smoke-tested first.

## Tasks

### Interface (FR-15)
- [ ] Implement the `Provider` interface from design §10 with `AbortSignal` support.
- [ ] Error classes: `ProviderTimeout`, `ProviderRateLimit`, `ProviderUnavailable`, `ProviderAuthError`, `ProviderInvalidResponse`.
- [ ] `createProvider({ name, model, apiKey, baseUrl })`: the key is passed in by the caller (the worker decrypts it). The package never reads environment variables.

### Adapters
- [ ] **DeepSeek (first):** OpenAI-compatible chat completions, configurable `baseUrl`, JSON mode. No strict schema enforcement, so describe the schema in the prompt, parse the JSON and rely on validation in Phase 7. Check DeepSeek's current docs for model IDs and JSON-mode behaviour before writing example config.
- [ ] Shared OpenAI-compatible base class used by DeepSeek and OpenAI; differences (base URL, structured output) stay in each adapter.
- [ ] **OpenAI:** structured outputs where available.
- [ ] **Anthropic:** structured JSON via tool use or schema output.
- [ ] Model IDs come only from configuration.

### Reliability and cost control (FR-16)
- [ ] Per-request timeout; exponential backoff with jitter on 429/5xx; honour `Retry-After`; no retry on 401/400.
- [ ] Respect cancellation: aborting the signal stops in-flight and queued requests.
- [ ] Concurrency limiter shared across agents in a run; per-run request and token budgets that stop new requests when exceeded and report a partial result.
- [ ] Low temperature or deterministic settings where supported.
- [ ] Return token usage with every response so the worker can store it per agent run (PL-07).

### Safety
- [ ] Outbound requests only to the provider's known host or a `baseUrl` already validated in Phase 4; re-check at call time (HTTPS, not a private address).
- [ ] Never log request bodies, prompts, responses or keys; log only provider, model, sizes, status and duration.
- [ ] `MockProvider` for tests and offline fixtures; `testConnection(provider)` helper reused by the credential "test connection" endpoint.
- [ ] Log a one-line notice of which provider receives code (privacy).

## Testing

- Mocked HTTP per adapter: success, malformed JSON, timeout, 429 with `Retry-After`, 5xx then success, 401.
- Cancellation mid-request and while waiting in the limiter.
- Budget cut-off and concurrency cap respected.
- Keys never appear in logs or error messages (planted canary).
- Manual smoke test against real DeepSeek with a trivial prompt.

## Deliverables

- `createProvider()` with DeepSeek, OpenAI, Anthropic and mock implementations.

## Exit criteria

- All failure-path tests pass; switching provider requires only changing the arguments to `createProvider`.

## Risks

- Structured-output behaviour differs by provider; keep translation inside each adapter.
- Provider API changes; isolate SDK/HTTP details and pin versions.
