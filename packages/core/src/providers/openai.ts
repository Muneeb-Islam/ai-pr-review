import type { ProviderOptions } from "./http-provider";
import { OpenAiCompatibleProvider, type ChatFormat } from "./openai-compatible";
import { describeJsonSchema, isStrictCompatible } from "./schema";
import type { ProviderRequest } from "./types";

export const OPENAI_BASE_URL = "https://api.openai.com/v1";

/** Reasoning models take `max_completion_tokens` and reject a temperature. */
const REASONING_MODEL = /^(o\d|gpt-5)/i;

/**
 * OpenAI: structured outputs (`json_schema`) on OpenAI's own endpoint. With a custom `baseUrl` (another
 * OpenAI-compatible server) the request falls back to plain JSON mode with the schema in the prompt, which
 * is what such servers reliably support.
 */
export class OpenAIProvider extends OpenAiCompatibleProvider {
  readonly name = "openai" as const;

  constructor(options: ProviderOptions) {
    super(options, OPENAI_BASE_URL);
  }

  protected chatFormat(req: ProviderRequest): ChatFormat {
    if (this.customBaseUrl) {
      return {
        responseFormat: { type: "json_object" },
        system: describeJsonSchema(req.system, req.jsonSchema),
      };
    }
    return {
      responseFormat: {
        type: "json_schema",
        json_schema: {
          name: "response",
          schema: req.jsonSchema,
          // Strict mode rejects schemas that leave properties optional; those are still sent, unenforced.
          strict: isStrictCompatible(req.jsonSchema),
        },
      },
      system: req.system,
    };
  }

  protected override tokenLimitField() {
    return this.customBaseUrl ? ("max_tokens" as const) : ("max_completion_tokens" as const);
  }

  protected override effectiveTemperature(): number | undefined {
    if (this.temperature === undefined && REASONING_MODEL.test(this.model)) return undefined;
    return super.effectiveTemperature();
  }
}
