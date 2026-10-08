import { registerSecret, type Logger } from "@ai-pr-review/shared";
import { AnthropicProvider, ANTHROPIC_BASE_URL } from "./anthropic";
import { DeepSeekProvider, DEEPSEEK_BASE_URL } from "./deepseek";
import type { RunGovernor } from "./governor";
import type { ProviderOptions } from "./http-provider";
import { OpenAIProvider, OPENAI_BASE_URL } from "./openai";
import type { Provider, ProviderName } from "./types";

/** Where each provider's API lives when no `base_url` is configured. */
export const DEFAULT_BASE_URLS: Record<ProviderName, string> = {
  deepseek: DEEPSEEK_BASE_URL,
  openai: OPENAI_BASE_URL,
  anthropic: ANTHROPIC_BASE_URL,
};

export interface CreateProviderOptions extends Omit<ProviderOptions, "baseUrl"> {
  name: ProviderName;
  baseUrl?: string | null | undefined;
  /** The run's shared limiter and budgets; every request of this provider goes through it. */
  governor?: RunGovernor;
}

const ADAPTERS: Record<ProviderName, new (options: ProviderOptions) => Provider> = {
  deepseek: DeepSeekProvider,
  openai: OpenAIProvider,
  anthropic: AnthropicProvider,
};

/**
 * The one way to get a provider. Switching provider means changing `name`, `model`, `apiKey` and `baseUrl`;
 * agents only ever see the `Provider` interface. The key is passed in by the caller (the worker decrypts it)
 * and is registered for log redaction; nothing here reads the environment.
 */
export function createProvider(options: CreateProviderOptions): Provider {
  const { name, governor, baseUrl, ...rest } = options;
  const Adapter = ADAPTERS[name];
  if (!Adapter) throw new TypeError("Unknown provider.");
  if (!rest.model) throw new TypeError("A model is required.");
  if (!rest.apiKey) throw new TypeError("An API key is required.");
  if (baseUrl && !/^https:\/\//i.test(baseUrl)) {
    throw new TypeError("base_url must use https://");
  }

  registerSecret(rest.apiKey);
  const provider = new Adapter({ ...rest, ...(baseUrl ? { baseUrl } : {}) });
  announce(rest.logger, name, rest.model, baseUrl || DEFAULT_BASE_URLS[name]);
  return governor ? governor.wrap(provider) : provider;
}

/** Privacy (decision log): say once which provider receives the code. Host only, never the full URL. */
function announce(logger: Logger | undefined, name: ProviderName, model: string, url: string) {
  if (!logger) return;
  let host = "unknown";
  try {
    host = new URL(url).host;
  } catch {
    // keep "unknown"
  }
  logger.info("code under review is sent to this provider", { provider: name, model, host });
}
