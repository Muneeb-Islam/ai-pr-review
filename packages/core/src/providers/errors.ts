import type { ProviderName } from "@ai-pr-review/shared";

/**
 * Base of every provider failure. Messages are fixed sentences: they never contain the request, the response
 * body (a provider can echo the prompt) or the key, so an error is always safe to log and to store.
 */
export class ProviderError extends Error {
  /** Retries made before this error was given up on; filled in by the retry loop. */
  retries = 0;
  constructor(
    message: string,
    readonly provider: ProviderName,
    readonly status?: number,
  ) {
    super(message);
    this.name = new.target.name;
  }
}

/** The request ran past its timeout. */
export class ProviderTimeout extends ProviderError {}

/** HTTP 429. `retryAfterMs` is the provider's `Retry-After` when it sent one. */
export class ProviderRateLimit extends ProviderError {
  constructor(
    message: string,
    provider: ProviderName,
    status?: number,
    readonly retryAfterMs?: number,
  ) {
    super(message, provider, status);
  }
}

/** Network failure, HTTP 5xx or an unusable endpoint. */
export class ProviderUnavailable extends ProviderError {}

/** HTTP 401 or 403: the key is wrong, revoked or not allowed to use the model. Never retried. */
export class ProviderAuthError extends ProviderError {}

/**
 * The provider answered, but not with usable output: a rejected request (HTTP 400), a response that is not
 * JSON, empty or cut off. `retryable` marks the known transient cases (an empty body).
 */
export class ProviderInvalidResponse extends ProviderError {
  constructor(
    message: string,
    provider: ProviderName,
    status?: number,
    readonly retryable = false,
  ) {
    super(message, provider, status);
  }
}

/** The run's request or token budget is used up (FR-16). The agent reports a partial result. */
export class ProviderBudgetExceeded extends ProviderError {}

/** The caller's `AbortSignal` fired, while waiting for a slot or during the request. */
export class ProviderCancelled extends ProviderError {}
