import type { Logger } from "@ai-pr-review/shared";
import { estimateTokens } from "../context/size";
import { validateBaseUrl, type BaseUrlCheck } from "../net/ssrf";
import {
  ProviderAuthError,
  ProviderCancelled,
  ProviderError,
  ProviderInvalidResponse,
  ProviderRateLimit,
  ProviderTimeout,
  ProviderUnavailable,
} from "./errors";
import { DEFAULT_RETRY_POLICY, parseRetryAfter, withRetry, type RetryPolicy } from "./retry";
import { createHttpsTransport, TransportError, type Transport } from "./transport";
import type {
  Provider,
  ProviderName,
  ProviderRequest,
  ProviderResponse,
  ProviderUsage,
} from "./types";

export interface ProviderOptions {
  model: string;
  /** Decrypted by the caller (the worker). This package never reads the environment. */
  apiKey: string;
  /** Optional OpenAI-compatible (or, for Anthropic, Messages API) endpoint; validated again on every call. */
  baseUrl?: string;
  /**
   * Sampling temperature. Defaults to 0 (deterministic where supported, FR-16); `null` leaves it out for
   * models that reject the parameter.
   */
  temperature?: number | null;
  logger?: Logger;
  retry?: Partial<RetryPolicy>;
  /** Test seams. */
  transport?: Transport;
  validateUrl?: (raw: string) => Promise<BaseUrlCheck>;
  now?: () => number;
}

/** What an adapter returns from parsing one response. */
export interface ParsedCompletion {
  json: unknown;
  usage?: ProviderUsage;
}

interface Call {
  path: string;
  headers: Record<string, string>;
  body: unknown;
}

const SAFE_STATUS_TEXT = "The provider answered with an error";

/**
 * Shared machinery of the HTTP adapters: endpoint checks, one request, status mapping, retries, logging.
 * Subclasses translate the neutral request into their API's shape and the response back (design §10).
 */
export abstract class HttpProvider implements Provider {
  abstract readonly name: ProviderName;
  readonly model: string;

  protected readonly apiKey: string;
  protected readonly baseUrl: string;
  protected readonly customBaseUrl: boolean;
  protected readonly temperature: number | null | undefined;
  protected readonly logger: Logger | undefined;
  private readonly transport: Transport;
  private readonly retryPolicy: RetryPolicy;
  private readonly validateUrl: (raw: string) => Promise<BaseUrlCheck>;
  private readonly now: () => number;

  protected constructor(options: ProviderOptions, defaultBaseUrl: string) {
    this.model = options.model;
    this.apiKey = options.apiKey;
    this.customBaseUrl = options.baseUrl !== undefined;
    this.baseUrl = (options.baseUrl ?? defaultBaseUrl).replace(/\/+$/, "");
    this.temperature = options.temperature;
    this.logger = options.logger;
    this.transport = options.transport ?? createHttpsTransport();
    this.retryPolicy = { ...DEFAULT_RETRY_POLICY, ...options.retry };
    this.validateUrl = options.validateUrl ?? ((raw) => validateBaseUrl(raw));
    this.now = options.now ?? Date.now;
  }

  /** The request this API wants for the neutral one. */
  protected abstract buildCall(req: ProviderRequest): Call;

  /** Extracts the model's JSON and the usage; throws `ProviderInvalidResponse` for anything unusable. */
  protected abstract parseCompletion(body: unknown): ParsedCompletion;

  async complete(req: ProviderRequest): Promise<ProviderResponse> {
    if (req.signal?.aborted) {
      throw new ProviderCancelled("The request was cancelled.", this.name);
    }
    await this.checkEndpoint();

    const call = this.buildCall(req);
    const url = new URL(`${this.baseUrl}${call.path}`);
    const body = JSON.stringify(call.body);
    const started = this.now();
    const fields = {
      provider: this.name,
      model: this.model,
      host: url.host,
      requestChars: body.length,
    };

    try {
      const { value, retries } = await withRetry(
        this.name,
        () => this.attempt(url, call.headers, body, req),
        this.retryPolicy,
        req.signal,
      );
      const usage = value.usage ?? {
        inputTokens: estimateTokens(req.system) + estimateTokens(req.user),
        outputTokens: estimateTokens(JSON.stringify(value.json)),
      };
      this.logger?.info("provider request", {
        ...fields,
        status: "ok",
        retries,
        inputTok: usage.inputTokens,
        outputTok: usage.outputTokens,
        durationMs: this.now() - started,
      });
      return { json: value.json, usage, model: this.model, retries };
    } catch (err) {
      this.logger?.warn("provider request", {
        ...fields,
        status: "failed",
        error: err instanceof Error ? err.name : "unknown",
        httpStatus: err instanceof ProviderError ? err.status : undefined,
        retries: err instanceof ProviderError ? err.retries : 0,
        durationMs: this.now() - started,
      });
      throw err;
    }
  }

  /** Re-checked on every call (design §9): a custom endpoint must still be https and public. */
  private async checkEndpoint(): Promise<void> {
    if (!this.customBaseUrl) return; // the provider's own host is a constant in this package
    const checked = await this.validateUrl(this.baseUrl);
    if (!checked.ok) {
      throw new ProviderUnavailable("The configured endpoint is not allowed.", this.name);
    }
  }

  private async attempt(
    url: URL,
    headers: Record<string, string>,
    body: string,
    req: ProviderRequest,
  ): Promise<ParsedCompletion> {
    let response;
    try {
      response = await this.transport({
        url,
        headers,
        body,
        timeoutMs: req.timeoutMs,
        ...(req.signal ? { signal: req.signal } : {}),
      });
    } catch (err) {
      const kind = err instanceof TransportError ? err.kind : "network";
      if (kind === "aborted" || req.signal?.aborted) {
        throw new ProviderCancelled("The request was cancelled.", this.name);
      }
      if (kind === "timeout") throw new ProviderTimeout("The provider timed out.", this.name);
      if (kind === "too_large") {
        throw new ProviderInvalidResponse("The provider response was too large.", this.name);
      }
      throw new ProviderUnavailable("The provider could not be reached.", this.name);
    }

    const { status } = response;
    if (status === 401 || status === 403) {
      throw new ProviderAuthError("The provider rejected the key.", this.name, status);
    }
    if (status === 429) {
      throw new ProviderRateLimit(
        "The provider is rate limiting requests.",
        this.name,
        status,
        parseRetryAfter(response.headers["retry-after"], this.now()),
      );
    }
    if (status === 408 || status >= 500) {
      throw new ProviderUnavailable(`${SAFE_STATUS_TEXT} (HTTP ${status}).`, this.name, status);
    }
    if (status < 200 || status >= 300) {
      throw new ProviderInvalidResponse(
        `The provider rejected the request (HTTP ${status}).`,
        this.name,
        status,
      );
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(response.body);
    } catch {
      throw new ProviderInvalidResponse("The provider response was not JSON.", this.name, status);
    }
    return this.parseCompletion(parsed);
  }

  protected invalid(message: string, retryable = false): ProviderInvalidResponse {
    return new ProviderInvalidResponse(message, this.name, undefined, retryable);
  }
}

/** Parses the model's text as JSON, tolerating a Markdown code fence around it. */
export function parseModelJson(text: string): unknown {
  let body = text.trim();
  const fenced = /^```(?:json)?\s*([\s\S]*?)\s*```$/i.exec(body);
  if (fenced) body = fenced[1]!;
  return JSON.parse(body);
}
