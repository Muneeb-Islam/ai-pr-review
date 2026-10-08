import { estimateTokens } from "../context/size";
import { ProviderCancelled } from "./errors";
import type { Provider, ProviderName, ProviderRequest, ProviderResponse } from "./types";

export type MockReply =
  | Error
  | ((req: ProviderRequest, call: number) => unknown)
  | Record<string, unknown>
  | unknown[]
  | string
  | number
  | boolean
  | null;

export interface MockProviderOptions {
  name?: ProviderName;
  model?: string;
  /** Replies in order; the last one repeats. An `Error` is thrown, a function is called, anything else is returned as the JSON. */
  replies?: MockReply[];
  /** Token usage reported per call. Defaults to an estimate from the request and the reply. */
  usage?: { inputTokens: number; outputTokens: number };
}

export interface MockProvider extends Provider {
  /** Every request received, in order. */
  readonly calls: ProviderRequest[];
}

/**
 * A scripted provider for tests and offline fixtures. Never touches the network. It honours the abort
 * signal like the real adapters, so cancellation paths can be tested against it.
 */
export function createMockProvider(options: MockProviderOptions = {}): MockProvider {
  const calls: ProviderRequest[] = [];
  const replies = options.replies ?? [{}];
  const name = options.name ?? "deepseek";
  return {
    name,
    model: options.model ?? "mock-model",
    calls,
    async complete(req): Promise<ProviderResponse> {
      if (req.signal?.aborted) throw new ProviderCancelled("The request was cancelled.", name);
      const index = calls.length;
      calls.push(req);
      const reply = replies[Math.min(index, replies.length - 1)];
      const value = typeof reply === "function" ? await reply(req, index) : reply;
      if (value instanceof Error) throw value;
      return {
        json: value,
        usage: options.usage ?? {
          inputTokens: estimateTokens(req.system) + estimateTokens(req.user),
          outputTokens: estimateTokens(JSON.stringify(value) ?? ""),
        },
        model: options.model ?? "mock-model",
        retries: 0,
      };
    },
  };
}
