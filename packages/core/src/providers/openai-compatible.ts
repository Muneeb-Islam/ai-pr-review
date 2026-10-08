import { z } from "zod";
import {
  HttpProvider,
  parseModelJson,
  type ParsedCompletion,
  type ProviderOptions,
} from "./http-provider";
import type { ProviderRequest } from "./types";

const responseSchema = z.object({
  choices: z
    .array(
      z.object({
        finish_reason: z.string().nullish(),
        message: z.object({
          content: z.string().nullish(),
          refusal: z.string().nullish(),
        }),
      }),
    )
    .min(1),
  usage: z
    .object({
      prompt_tokens: z.number().nonnegative(),
      completion_tokens: z.number().nonnegative(),
    })
    .nullish(),
});

export interface ChatFormat {
  /** The `response_format` member of the request. */
  responseFormat: Record<string, unknown>;
  /** The system prompt, extended when the format cannot carry the schema. */
  system: string;
}

/**
 * Chat completions in the OpenAI shape, used by DeepSeek and OpenAI. What differs between them (endpoint,
 * how the schema is conveyed, token parameter, temperature support) is decided by the subclasses.
 */
export abstract class OpenAiCompatibleProvider extends HttpProvider {
  /** An empty reply is a known transient fault of some endpoints; retry it instead of failing the agent. */
  protected readonly retryEmptyContent: boolean = false;

  protected constructor(options: ProviderOptions, defaultBaseUrl: string) {
    super(options, defaultBaseUrl);
  }

  protected abstract chatFormat(req: ProviderRequest): ChatFormat;

  /** The request member that caps the output; OpenAI's newer models only accept `max_completion_tokens`. */
  protected tokenLimitField(): "max_tokens" | "max_completion_tokens" {
    return "max_tokens";
  }

  /** `undefined` leaves the parameter out. */
  protected effectiveTemperature(): number | undefined {
    return this.temperature === null ? undefined : (this.temperature ?? 0);
  }

  protected buildCall(req: ProviderRequest) {
    const format = this.chatFormat(req);
    const temperature = this.effectiveTemperature();
    return {
      path: "/chat/completions",
      headers: {
        authorization: `Bearer ${this.apiKey}`,
        accept: "application/json",
        "user-agent": "ai-pr-review",
      },
      body: {
        model: this.model,
        messages: [
          { role: "system", content: format.system },
          { role: "user", content: req.user },
        ],
        [this.tokenLimitField()]: req.maxOutputTokens,
        response_format: format.responseFormat,
        ...(temperature === undefined ? {} : { temperature }),
        stream: false,
      },
    };
  }

  protected parseCompletion(body: unknown): ParsedCompletion {
    const parsed = responseSchema.safeParse(body);
    if (!parsed.success) throw this.invalid("The provider response had an unexpected shape.");
    const choice = parsed.data.choices[0]!;
    const content = choice.message.content?.trim() ?? "";

    if (choice.message.refusal) throw this.invalid("The model declined to answer.");
    if (choice.finish_reason === "length") {
      throw this.invalid("The response was cut off at the output token limit.");
    }
    if (content === "") {
      throw this.invalid("The provider returned an empty response.", this.retryEmptyContent);
    }

    let json: unknown;
    try {
      json = parseModelJson(content);
    } catch {
      throw this.invalid("The model output was not valid JSON.");
    }
    const usage = parsed.data.usage;
    return {
      json,
      ...(usage
        ? { usage: { inputTokens: usage.prompt_tokens, outputTokens: usage.completion_tokens } }
        : {}),
    };
  }
}
