import {
  ProviderAuthError,
  ProviderBudgetExceeded,
  ProviderCancelled,
  ProviderError,
  ProviderInvalidResponse,
  ProviderRateLimit,
  ProviderTimeout,
} from "./errors";
import type { Provider } from "./types";

export interface ConnectionResult {
  ok: boolean;
  /** One of a few fixed sentences: provider output, URLs and the key never come back. */
  message: string;
}

const CHECK_SCHEMA = {
  type: "object",
  properties: { ok: { type: "boolean" } },
  required: ["ok"],
  additionalProperties: false,
};

/**
 * Proves a provider, model and key work with one minimal completion (about 50 tokens). The credential
 * "test connection" endpoint, which has no model to ask with, checks the key against the provider's model
 * list instead; this is for callers that do know the model (the worker before a run, scripts).
 */
export async function testConnection(
  provider: Provider,
  options: { timeoutMs?: number; signal?: AbortSignal } = {},
): Promise<ConnectionResult> {
  try {
    await provider.complete({
      system: 'You check connectivity. Reply with the json object {"ok": true}.',
      user: "ping",
      jsonSchema: CHECK_SCHEMA,
      maxOutputTokens: 32,
      timeoutMs: options.timeoutMs ?? 15_000,
      ...(options.signal ? { signal: options.signal } : {}),
    });
    return { ok: true, message: "The provider accepted the key and model." };
  } catch (err) {
    return { ok: false, message: describe(err) };
  }
}

function describe(err: unknown): string {
  if (err instanceof ProviderAuthError) return "The provider rejected the key.";
  if (err instanceof ProviderRateLimit) {
    return "The provider is rate limiting requests; the key could not be checked.";
  }
  if (err instanceof ProviderTimeout) return "The provider timed out.";
  if (err instanceof ProviderCancelled) return "The check was cancelled.";
  if (err instanceof ProviderBudgetExceeded) return "The request budget is used up.";
  if (err instanceof ProviderInvalidResponse) {
    return err.status === 400 || err.status === 404
      ? "The provider did not accept the request; check the model name."
      : "The provider answered, but not with usable output.";
  }
  if (err instanceof ProviderError) return "The provider could not be reached.";
  return "The provider could not be reached.";
}
