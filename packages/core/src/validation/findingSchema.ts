import { SEVERITIES, type Category } from "@ai-pr-review/shared";
import { z } from "zod";

// What a model returns (design §10, §11). The field names are snake_case and the optional fields are nullable
// so the schema meets OpenAI's strict structured-output rules (every property required, no extras). Parsing is
// more forgiving than the schema we send: unknown keys are dropped and the nullable fields may be missing.

export const MAX_FINDINGS_PER_RESPONSE = 40;
export const MAX_OBSERVATIONS_PER_RESPONSE = 10;

const optionalText = z.string().nullish();
const optionalLine = z.number().int().positive().nullish();

export function createRawFindingSchema<const C extends readonly [Category, ...Category[]]>(
  categories: C,
) {
  return z.object({
    category: z.enum(categories),
    severity: z.enum(SEVERITIES),
    confidence: z.number().min(0).max(1),
    title: z.string().trim().min(1),
    file_path: optionalText,
    start_line: optionalLine,
    end_line: optionalLine,
    evidence: z.string(),
    impact: z.string(),
    recommendation: z.string(),
    suggested_test: optionalText,
  });
}

export function createAgentOutputSchema<const C extends readonly [Category, ...Category[]]>(
  categories: C,
) {
  return z.object({
    findings: z.array(createRawFindingSchema(categories)).max(MAX_FINDINGS_PER_RESPONSE),
    observations: z.array(z.string()).max(MAX_OBSERVATIONS_PER_RESPONSE).nullish(),
  });
}

export type RawFinding = z.output<ReturnType<typeof createRawFindingSchema>>;
export type AgentOutput = z.output<ReturnType<typeof createAgentOutputSchema>>;

/**
 * The JSON Schema sent with every request. Written out by hand so it stays within what all three providers
 * accept (strict-compatible: all properties required, `additionalProperties: false`, nullable instead of optional).
 */
export function createAgentJsonSchema(categories: readonly Category[]): object {
  const nullable = (type: "string" | "integer", description: string) => ({
    type: [type, "null"],
    description,
  });
  return {
    type: "object",
    additionalProperties: false,
    required: ["findings", "observations"],
    properties: {
      findings: {
        type: "array",
        description: `At most ${MAX_FINDINGS_PER_RESPONSE} findings. An empty array when there is nothing to report.`,
        items: {
          type: "object",
          additionalProperties: false,
          required: [
            "category",
            "severity",
            "confidence",
            "title",
            "file_path",
            "start_line",
            "end_line",
            "evidence",
            "impact",
            "recommendation",
            "suggested_test",
          ],
          properties: {
            category: { type: "string", enum: [...categories] },
            severity: { type: "string", enum: [...SEVERITIES] },
            confidence: {
              type: "number",
              description: "Your confidence that this is a real problem, from 0.0 to 1.0.",
            },
            title: { type: "string", description: "One short sentence naming the problem." },
            file_path: nullable(
              "string",
              "Path exactly as shown in the diff; null for a general finding.",
            ),
            start_line: nullable(
              "integer",
              "First line (new-file number, an added line); null if general.",
            ),
            end_line: nullable("integer", "Last line of the range, or the same as start_line."),
            evidence: {
              type: "string",
              description:
                "A short quote (one or two lines) copied from the added code that shows the problem.",
            },
            impact: {
              type: "string",
              description: "What goes wrong for users or maintainers if this is merged as is.",
            },
            recommendation: { type: "string", description: "The concrete change to make." },
            suggested_test: nullable("string", "A test that would catch it, or null."),
          },
        },
      },
      observations: {
        type: "array",
        description: `At most ${MAX_OBSERVATIONS_PER_RESPONSE} short notes for the summary that are not findings.`,
        items: { type: "string" },
      },
    },
  };
}
