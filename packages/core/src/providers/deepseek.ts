import type { ProviderOptions } from "./http-provider";
import { OpenAiCompatibleProvider, type ChatFormat } from "./openai-compatible";
import { describeJsonSchema } from "./schema";
import type { ProviderRequest } from "./types";

export const DEEPSEEK_BASE_URL = "https://api.deepseek.com";

/**
 * DeepSeek: OpenAI-compatible chat completions with JSON mode. JSON mode guarantees valid JSON, not the
 * schema, so the schema is described in the prompt and the caller validates (Phase 7). The API requires the
 * word "json" and an example in the prompt, and occasionally returns an empty body, which is retried.
 */
export class DeepSeekProvider extends OpenAiCompatibleProvider {
  readonly name = "deepseek" as const;
  protected override readonly retryEmptyContent = true;

  constructor(options: ProviderOptions) {
    super(options, DEEPSEEK_BASE_URL);
  }

  protected chatFormat(req: ProviderRequest): ChatFormat {
    return {
      responseFormat: { type: "json_object" },
      system: describeJsonSchema(req.system, req.jsonSchema),
    };
  }
}
