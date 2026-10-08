import { estimateTokens } from "../context/size";
import { ProviderBudgetExceeded, ProviderCancelled } from "./errors";
import type { Provider, ProviderRequest, ProviderResponse, ProviderUsage } from "./types";

export interface GovernorLimits {
  /** Requests in flight at once, across every agent of the run. */
  concurrency: number;
  /** Requests the run may start (a retried request counts once). */
  maxRequests: number;
  /** Input plus output tokens the run may use. */
  maxTotalTokens: number;
}

export interface GovernorSnapshot {
  requests: number;
  usage: ProviderUsage;
  /** Requests refused because a budget was used up. */
  refused: number;
}

/** The `limits` block of the resolved config (design §6) is exactly these three numbers plus a timeout. */
export function governorLimits(limits: {
  concurrency: number;
  max_requests: number;
  max_total_tokens: number;
}): GovernorLimits {
  return {
    concurrency: limits.concurrency,
    maxRequests: limits.max_requests,
    maxTotalTokens: limits.max_total_tokens,
  };
}

interface Waiter {
  grant: () => void;
  cancel: () => void;
}

/**
 * One per review run, shared by every agent's provider (FR-16): caps concurrent requests, and stops starting
 * new ones once the request or token budget is spent. Waiting requests are served in order and can be
 * cancelled by their signal. Budgets are checked when a request gets its slot, using the estimated input
 * plus the full output allowance of everything in flight, so parallel agents cannot overshoot together.
 */
export class RunGovernor {
  private active = 0;
  private started = 0;
  private refusedCount = 0;
  private inputTokens = 0;
  private outputTokens = 0;
  private reservedTokens = 0;
  private readonly queue: Waiter[] = [];

  constructor(private readonly limits: GovernorLimits) {
    if (limits.concurrency < 1) throw new RangeError("concurrency must be at least 1");
  }

  snapshot(): GovernorSnapshot {
    return {
      requests: this.started,
      usage: { inputTokens: this.inputTokens, outputTokens: this.outputTokens },
      refused: this.refusedCount,
    };
  }

  /** Wraps a provider so its requests go through this governor. */
  wrap(provider: Provider): Provider {
    return {
      name: provider.name,
      model: provider.model,
      complete: (req) => this.run(provider, req),
    };
  }

  private async run(provider: Provider, req: ProviderRequest): Promise<ProviderResponse> {
    await this.acquire(provider, req.signal);
    const reserve = estimateTokens(req.system) + estimateTokens(req.user) + req.maxOutputTokens;
    try {
      if (this.started >= this.limits.maxRequests) {
        this.refusedCount++;
        throw new ProviderBudgetExceeded("The run's request budget is used up.", provider.name);
      }
      if (
        this.inputTokens + this.outputTokens + this.reservedTokens + reserve >
        this.limits.maxTotalTokens
      ) {
        this.refusedCount++;
        throw new ProviderBudgetExceeded("The run's token budget is used up.", provider.name);
      }
      this.started++;
      this.reservedTokens += reserve;
      try {
        const response = await provider.complete(req);
        this.inputTokens += response.usage.inputTokens;
        this.outputTokens += response.usage.outputTokens;
        return response;
      } finally {
        this.reservedTokens -= reserve;
      }
    } finally {
      this.release();
    }
  }

  private acquire(provider: Provider, signal?: AbortSignal): Promise<void> {
    const cancelled = () => new ProviderCancelled("The request was cancelled.", provider.name);
    if (signal?.aborted) return Promise.reject(cancelled());
    if (this.active < this.limits.concurrency) {
      this.active++;
      return Promise.resolve();
    }
    return new Promise((resolve, reject) => {
      const onAbort = () => {
        const index = this.queue.indexOf(waiter);
        if (index >= 0) this.queue.splice(index, 1);
        reject(cancelled());
      };
      const waiter: Waiter = {
        grant: () => {
          signal?.removeEventListener("abort", onAbort);
          resolve();
        },
        cancel: onAbort,
      };
      this.queue.push(waiter);
      signal?.addEventListener("abort", onAbort, { once: true });
    });
  }

  private release(): void {
    const next = this.queue.shift();
    if (next)
      next.grant(); // the slot passes straight to the next waiter
    else this.active--;
  }
}
