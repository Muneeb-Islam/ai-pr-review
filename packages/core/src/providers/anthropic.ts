import { z } from "zod";
import { HttpProvider, type ParsedCompletion, type ProviderOptions } from "./http-provider";
import type { ProviderRequest } from "./types";

export const ANTHROPIC_BASE_URL = "https://api.anthropic.com/v1";
export const ANTHROPIC_VERSION = "2023-06-01";
const TOOL_NAME = "report";

const responseSchema = z.object({
  stop_reason: z.string().nullish(),
  content: z.array(
    z.object({ type: z.string(), name: z.string().optional(), input: z.unknown().optional() }),
  ),
  usage: z
    .object({ input_tokens: z.number().nonnegative(), output_tokens: z.number().nonnegative() })
    .nullish(),
});

/**
 * Anthropic Messages API. Structured JSON comes from forced tool use: the schema becomes the input schema of
 * one tool the model must call, so the answer arrives already parsed. The tool is never executed.
 */
export class AnthropicProvider extends HttpProvider {
  readonly name = "anthropic" as const;

  constructor(options: ProviderOptions) {
    super(options, ANTHROPIC_BASE_URL);
  }

  protected buildCall(req: ProviderRequest) {
    const temperature = this.temperature === null ? undefined : (this.temperature ?? 0);
    return {
      path: "/messages",
      headers: {
        "x-api-key": this.apiKey,
        "anthropic-version": ANTHROPIC_VERSION,
        accept: "application/json",
        "user-agent": "ai-pr-review",
      },
      body: {
        model: this.model,
        max_tokens: req.maxOutputTokens,
        ...(temperature === undefined ? {} : { temperature }),
        system: req.system,
        messages: [{ role: "user", content: req.user }],
        tools: [
          {
            name: TOOL_NAME,
            description: "Report the result as structured data.",
            input_schema: req.jsonSchema,
          },
        ],
        tool_choice: { type: "tool", name: TOOL_NAME },
      },
    };
  }

  protected parseCompletion(body: unknown): ParsedCompletion {
    const parsed = responseSchema.safeParse(body);
    if (!parsed.success) throw this.invalid("The provider response had an unexpected shape.");
    if (parsed.data.stop_reason === "max_tokens") {
      throw this.invalid("The response was cut off at the output token limit.");
    }
    if (parsed.data.stop_reason === "refusal") throw this.invalid("The model declined to answer.");
    const block = parsed.data.content.find((b) => b.type === "tool_use" && b.name === TOOL_NAME);
    if (!block || block.input === undefined || typeof block.input !== "object") {
      throw this.invalid("The model did not return structured output.");
    }
    const usage = parsed.data.usage;
    return {
      json: block.input,
      ...(usage
        ? { usage: { inputTokens: usage.input_tokens, outputTokens: usage.output_tokens } }
        : {}),
    };
  }
}
