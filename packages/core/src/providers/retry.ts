import {
  ProviderCancelled,
  ProviderError,
  ProviderInvalidResponse,
  ProviderRateLimit,
  ProviderTimeout,
  ProviderUnavailable,
} from "./errors";
import type { ProviderName } from "./types";

export interface RetryPolicy {
  /** Retries after the first attempt. */
  maxRetries: number;
  baseDelayMs: number;
  maxDelayMs: number;
  /** A `Retry-After` longer than this is not waited for: the rate-limit error goes to the caller. */
  maxRetryAfterMs: number;
  /** Test seams. */
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  random?: () => number;
}

export const DEFAULT_RETRY_POLICY: RetryPolicy = {
  maxRetries: 2,
  baseDelayMs: 500,
  maxDelayMs: 8_000,
  maxRetryAfterMs: 30_000,
};

/** Parses `Retry-After`: delta-seconds or an HTTP date. Returns milliseconds, or undefined. */
export function parseRetryAfter(value: string | undefined, now = Date.now()): number | undefined {
  if (!value) return undefined;
  const text = value.trim();
  if (/^\d+(\.\d+)?$/.test(text)) return Math.round(Number(text) * 1000);
  const date = Date.parse(text);
  return Number.isNaN(date) ? undefined : Math.max(0, date - now);
}

export function abortableSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason);
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal?.reason);
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

function retryable(err: ProviderError, attempt: number, policy: RetryPolicy): boolean {
  if (attempt >= policy.maxRetries) return false;
  if (err instanceof ProviderRateLimit) {
    return err.retryAfterMs === undefined || err.retryAfterMs <= policy.maxRetryAfterMs;
  }
  if (err instanceof ProviderUnavailable) return true;
  // A timeout already cost the full request time; one more try, not more.
  if (err instanceof ProviderTimeout) return attempt < 1;
  if (err instanceof ProviderInvalidResponse) return err.retryable;
  return false; // auth, rejected requests, budget, cancellation
}

/**
 * Runs `attempt` until it succeeds or fails for a reason that retrying cannot fix (401, 400, cancellation),
 * with exponential backoff and jitter on 429, 5xx, network errors and timeouts. Honours `Retry-After`.
 * Aborting the signal stops the wait and the loop.
 */
export async function withRetry<T>(
  provider: ProviderName,
  attempt: () => Promise<T>,
  policy: RetryPolicy,
  signal?: AbortSignal,
): Promise<{ value: T; retries: number }> {
  const sleep = policy.sleep ?? abortableSleep;
  const random = policy.random ?? Math.random;
  for (let n = 0; ; n++) {
    if (signal?.aborted) throw new ProviderCancelled("The request was cancelled.", provider);
    try {
      return { value: await attempt(), retries: n };
    } catch (err) {
      if (!(err instanceof ProviderError)) throw err;
      err.retries = n;
      if (!retryable(err, n, policy)) throw err;
      const cap = Math.min(policy.maxDelayMs, policy.baseDelayMs * 2 ** n);
      // Equal jitter: at least half the backoff, so a burst of retries still spreads out.
      const backoff = cap / 2 + (random() * cap) / 2;
      const delay =
        err instanceof ProviderRateLimit && err.retryAfterMs !== undefined
          ? Math.max(err.retryAfterMs, backoff)
          : backoff;
      try {
        await sleep(delay, signal);
      } catch {
        throw new ProviderCancelled("The request was cancelled.", provider);
      }
    }
  }
}
