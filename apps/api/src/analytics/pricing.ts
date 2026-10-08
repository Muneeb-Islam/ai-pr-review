// A rough price per million tokens for each provider, to turn the token counts the runs report into a cost
// estimate (UI-07). These are placeholders at the cheap-to-mid end of each provider's range: real prices depend on
// the model, change often and may differ by contract. The dashboard labels the figure an estimate and says which
// provider it assumed; edit this table (or set a better source) before anyone budgets from it.
import type { PROVIDERS } from "@ai-pr-review/shared";

export type ProviderName = (typeof PROVIDERS)[number];

export interface TokenPrice {
  /** US dollars per million input tokens. */
  input: number;
  /** US dollars per million output tokens. */
  output: number;
}

export const ESTIMATED_PRICES: Record<ProviderName, TokenPrice> = {
  deepseek: { input: 0.3, output: 0.5 },
  openai: { input: 2.5, output: 10 },
  anthropic: { input: 3, output: 15 },
};

export function estimateCostUsd(
  provider: ProviderName,
  tokens: { inputTokens: number; outputTokens: number },
): number {
  const price = ESTIMATED_PRICES[provider];
  return (tokens.inputTokens * price.input + tokens.outputTokens * price.output) / 1_000_000;
}
