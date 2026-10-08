// "Test connection" for provider keys (PL-10): one minimal, read-only provider call that proves the key is
// accepted. It lists models rather than calling `testConnection` (packages/core), because the request carries
// a key but no model, and listing costs no tokens. The answer is one of a few fixed sentences: provider output, URLs and the key never come back.
import { DEFAULT_BASE_URLS, httpsStatus, type OutboundResponse } from "@ai-pr-review/core";
import type { ProviderName } from "@ai-pr-review/shared";

export interface ProbeInput {
  provider: ProviderName;
  apiKey: string;
  /** Already validated (https, public address). */
  baseUrl: URL;
}

export interface ProbeResult {
  ok: boolean;
  message: string;
}

export interface ProviderProbe {
  check(input: ProbeInput): Promise<ProbeResult>;
}

export { DEFAULT_BASE_URLS };

const PROBE_TIMEOUT_MS = 10_000;

export function createProviderProbe(
  options: {
    timeoutMs?: number;
    request?: (
      url: URL,
      options: { headers: Record<string, string>; timeoutMs: number },
    ) => Promise<OutboundResponse>;
  } = {},
): ProviderProbe {
  const request = options.request ?? ((url, o) => httpsStatus(url, o));
  return {
    async check({ provider, apiKey, baseUrl }) {
      // Both APIs list their models: authenticated, cheap, no tokens consumed.
      const url = new URL(baseUrl.toString());
      url.pathname = `${url.pathname.replace(/\/+$/, "")}/models`;
      url.search = "";
      const headers: Record<string, string> =
        provider === "anthropic"
          ? { "x-api-key": apiKey, "anthropic-version": "2023-06-01" }
          : { authorization: `Bearer ${apiKey}` };
      headers["accept"] = "application/json";
      headers["user-agent"] = "ai-pr-review";

      let status: number;
      try {
        ({ status } = await request(url, {
          headers,
          timeoutMs: options.timeoutMs ?? PROBE_TIMEOUT_MS,
        }));
      } catch {
        return { ok: false, message: "The provider could not be reached." };
      }
      if (status >= 200 && status < 300)
        return { ok: true, message: "The provider accepted the key." };
      if (status === 401 || status === 403) {
        return { ok: false, message: "The provider rejected the key." };
      }
      if (status === 429) {
        return {
          ok: false,
          message: "The provider is rate limiting requests; the key could not be checked.",
        };
      }
      return { ok: false, message: `The provider answered with an error (HTTP ${status}).` };
    },
  };
}
