// What a person should know before choosing where their code is sent (decision log: provider notes, design §9).
// Shown next to the provider choice and next to each provider's key.

export interface ProviderNotice {
  name: string;
  /** One or two sentences on who receives the code. */
  notice: string;
  /** Present for a provider whose operator or location many organisations need to weigh. */
  caution?: string;
}

export const PROVIDER_NOTICES: Record<string, ProviderNotice> = {
  deepseek: {
    name: "DeepSeek",
    notice:
      "Changed code and nearby context from your pull requests are sent to DeepSeek's hosted API under your own key.",
    caution:
      "The hosted DeepSeek API is operated by a China-based company. If your organisation cannot accept that, choose another provider or a self-hosted endpoint.",
  },
  anthropic: {
    name: "Anthropic",
    notice:
      "Changed code and nearby context from your pull requests are sent to Anthropic's API under your own key and subject to Anthropic's data terms.",
  },
  openai: {
    name: "OpenAI",
    notice:
      "Changed code and nearby context from your pull requests are sent to OpenAI's API under your own key and subject to OpenAI's data terms.",
  },
};

/** What every provider has in common: the review sends only what it needs and keeps no code. */
export const COMMON_PRIVACY_NOTE =
  "Files that match the secret paths are never sent. The platform stores findings with short excerpts, not diffs or source files.";
