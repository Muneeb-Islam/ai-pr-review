import type { ProviderName } from "@ai-pr-review/shared";

export type { ProviderName };

export interface ProviderRequest {
  system: string;
  user: string;
  /** JSON Schema of the answer. Each adapter translates it to what its API supports. */
  jsonSchema: object;
  maxOutputTokens: number;
  timeoutMs: number;
  signal?: AbortSignal;
}

export interface ProviderUsage {
  inputTokens: number;
  outputTokens: number;
}

export interface ProviderResponse {
  /** Parsed JSON from the model. Not yet validated against the schema (Phase 7 does that). */
  json: unknown;
  usage: ProviderUsage;
  model: string;
  /** Retries made for this response (0 when the first attempt worked). */
  retries: number;
}

export interface Provider {
  readonly name: ProviderName;
  readonly model: string;
  complete(req: ProviderRequest): Promise<ProviderResponse>;
}
