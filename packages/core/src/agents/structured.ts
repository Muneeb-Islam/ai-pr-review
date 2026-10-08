import type { AgentId, AgentRunStatus, Category, Finding, TokenUsage } from "@ai-pr-review/shared";
import type { ChangedFile, ReviewContext } from "../context/types";
import { estimateTokens } from "../context/size";
import {
  ProviderAuthError,
  ProviderBudgetExceeded,
  ProviderCancelled,
  ProviderInvalidResponse,
  ProviderRateLimit,
  ProviderTimeout,
  ProviderUnavailable,
} from "../providers/errors";
import {
  composeRepairPrompt,
  composeSystemPrompt,
  composeUserPrompt,
  createDelimiterId,
  type PromptDefinition,
} from "../prompts";
import {
  createAgentJsonSchema,
  createAgentOutputSchema,
  MAX_OBSERVATIONS_PER_RESPONSE,
  type RawFinding,
} from "../validation/findingSchema";
import { fingerprintFinding } from "../validation/fingerprint";
import { chunkDiff, type DiffChunk } from "./diff-render";
import type { Agent, AgentCoverage, AgentDeps, AgentResult, AgentTask } from "./types";

// The shared machinery of an agent that asks a model for findings: prompt, chunking, one request per chunk,
// validation with one repair retry, normalisation. The Code Review agent is this plus a prompt; Test Coverage and
// Security (Phases 11, 12) reuse it.

/** Diff tokens per request unless an agent says otherwise. */
export const DEFAULT_MAX_INPUT_TOKENS = 24_000;
export const DEFAULT_MAX_OUTPUT_TOKENS = 4_096;

const TITLE_MAX = 200;
const EVIDENCE_MAX = 500; // `findings.evidence` is varchar(500)
const TEXT_MAX = 1_000;
const OBSERVATION_MAX = 300;

/** What an agent adds to its request before asking the model, and to its result regardless of the answer. */
export interface PreparedRun {
  /** Extra sections for the user message (inside the untrusted block). Titles are ours, bodies are data. */
  sections?: Array<{ title: string; body: string }>;
  /** Measured coverage to put on the result (Test Coverage). */
  coverage?: AgentCoverage;
  /** Warnings for the summary, as fixed sentences. */
  warnings?: string[];
  observations?: string[];
  /** There is nothing to ask the model: finish with the prepared result and no request. */
  skipModel?: boolean;
}

export interface LlmAgentOptions {
  id: AgentId;
  label: string;
  prompt: PromptDefinition;
  /** Categories this agent may assign; anything else is a schema violation. */
  categories: readonly [Category, ...Category[]];
  selectFiles?: (context: ReviewContext) => ChangedFile[];
  maxInputTokens?: number;
  maxOutputTokens?: number;
  /** Runs before the request: gathers extra context and may decide the model is not needed. */
  prepare?: (task: AgentTask, deps: AgentDeps) => Promise<PreparedRun>;
  /** Final say over the normalised findings (drop or adjust), before they reach the validator. */
  refine?: (findings: Finding[], task: AgentTask) => Finding[];
}

export type ChunkFailure = "failed" | "timeout" | "invalid_output" | "cancelled";

interface ChunkOutcome {
  findings: Finding[];
  observations: string[];
  usage: TokenUsage;
  retries: number;
  /** Set when no usable answer came back for this chunk. */
  failure?: { kind: ChunkFailure; warning: string };
}

const truncate = (text: string, max: number): string =>
  text.length <= max ? text : `${text.slice(0, max - 3)}...`;

/** Zod's own wording, path first: "findings.2.severity: Invalid option: ...". Never contains the received value. */
export function describeIssues(
  issues: readonly { path: PropertyKey[]; message: string }[],
): string[] {
  return issues.slice(0, 15).map((issue) => {
    const path = issue.path.map(String).join(".") || "(answer)";
    return `${path}: ${issue.message}`;
  });
}

/** A path the model wrote, mapped to one of the reviewed files where it differs only by a diff-style prefix. */
function normalizePath(
  raw: string | null | undefined,
  known: ReadonlySet<string>,
): string | undefined {
  const path = raw?.trim();
  if (!path) return undefined;
  if (known.has(path)) return path;
  for (const candidate of [
    path.replace(/^\.\//, ""),
    path.replace(/^\/+/, ""),
    path.replace(/^[ab]\//, ""),
  ]) {
    if (known.has(candidate)) return candidate;
  }
  return path;
}

function toFinding(
  raw: RawFinding,
  agent: AgentId,
  headSha: string,
  known: ReadonlySet<string>,
): Finding {
  const filePath = normalizePath(raw.file_path, known);
  const startLine = raw.start_line ?? undefined;
  const endLine = raw.end_line ?? undefined;
  const title = truncate(raw.title.trim(), TITLE_MAX);
  const suggestedTest = raw.suggested_test?.trim();
  return {
    id: fingerprintFinding({ category: raw.category, title, filePath, startLine }),
    agent,
    category: raw.category,
    severity: raw.severity,
    confidence: raw.confidence,
    title,
    ...(filePath === undefined ? {} : { filePath }),
    ...(startLine === undefined ? {} : { startLine }),
    ...(endLine === undefined ? {} : { endLine }),
    evidence: truncate(raw.evidence.trim(), EVIDENCE_MAX),
    impact: truncate(raw.impact.trim(), TEXT_MAX),
    recommendation: truncate(raw.recommendation.trim(), TEXT_MAX),
    ...(suggestedTest ? { suggestedTest: truncate(suggestedTest, TEXT_MAX) } : {}),
    sourceCommitSha: headSha,
  };
}

/** Fixed sentences only: a provider error's own text is already safe, but these also say what it means. */
export function failureOf(err: unknown, label: string): { kind: ChunkFailure; warning: string } {
  if (err instanceof ProviderCancelled) return { kind: "cancelled", warning: "" };
  if (err instanceof ProviderTimeout) {
    return { kind: "timeout", warning: `${label}: the AI provider timed out.` };
  }
  if (err instanceof ProviderAuthError) {
    return {
      kind: "failed",
      warning: `${label}: the AI provider rejected the API key, or the key is not allowed to use the model.`,
    };
  }
  if (err instanceof ProviderRateLimit) {
    return { kind: "failed", warning: `${label}: the AI provider kept rate limiting requests.` };
  }
  if (err instanceof ProviderUnavailable) {
    return { kind: "failed", warning: `${label}: the AI provider was unavailable.` };
  }
  if (err instanceof ProviderBudgetExceeded) {
    return {
      kind: "failed",
      warning: `${label}: the run's request or token budget was used up, so part of the diff was not reviewed.`,
    };
  }
  if (err instanceof ProviderInvalidResponse) {
    return { kind: "failed", warning: `${label}: the AI provider could not process the request.` };
  }
  return { kind: "failed", warning: `${label}: the review failed unexpectedly.` };
}

/** An answer that was not JSON or was cut off can be asked for again; a rejected request (HTTP 4xx) cannot. */
export const isRepairable = (err: unknown): boolean =>
  err instanceof ProviderInvalidResponse && (err.status === undefined || err.status < 400);

export const retriesOf = (err: unknown): number =>
  typeof err === "object" && err !== null && "retries" in err && typeof err.retries === "number"
    ? err.retries
    : 0;

export function createLlmAgent(options: LlmAgentOptions): Agent {
  const outputSchema = createAgentOutputSchema(options.categories);
  const jsonSchema = createAgentJsonSchema(options.categories);
  const { id, label, prompt } = options;

  return {
    id,
    label,
    ...(options.selectFiles ? { selectFiles: options.selectFiles } : {}),

    async run(task: AgentTask, deps: AgentDeps): Promise<AgentResult> {
      const now = deps.now ?? Date.now;
      const started = now();
      const { provider, logger } = deps;
      const { context, config } = task;
      const known = new Set(task.files.map((file) => file.path));
      const instructions = task.repoInstructions ?? config.instructions;
      const prepared: PreparedRun = (await options.prepare?.(task, deps)) ?? {};
      const sections = prepared.sections ?? [];
      const preparedWarnings = prepared.warnings ?? [];
      const preparedObservations = prepared.observations ?? [];
      const emptyUsage: TokenUsage = { inputTokens: 0, outputTokens: 0 };
      if (prepared.skipModel) {
        const durationMs = Math.max(0, now() - started);
        logger.info("Agent finished", {
          agent: id,
          status: "ok",
          prompt: `${prompt.id}.v${prompt.version}`,
          model: "not called",
          requests: 0,
          requestChars: 0,
          durationMs,
        });
        return {
          agent: id,
          status: "ok",
          findings: [],
          observations: preparedObservations,
          ...(prepared.coverage ? { coverage: prepared.coverage } : {}),
          durationMs,
          usage: emptyUsage,
          retries: 0,
          warnings: preparedWarnings,
        };
      }

      // ---- prompt: one delimiter id for the whole agent run, absent from everything it wraps
      const untrusted = [
        context.pr.title,
        context.pr.body,
        instructions,
        ...sections.flatMap((section) => [section.title, section.body]),
        ...task.files.flatMap((file) => [file.path, file.previousPath ?? "", file.patch ?? ""]),
      ];
      const delimiterId = createDelimiterId(untrusted, deps.randomId);
      const system = composeSystemPrompt(prompt, delimiterId);

      const deletedPaths = context.files.filter((f) => f.status === "removed").map((f) => f.path);
      const promptInput = {
        delimiterId,
        pr: context.pr,
        instructions,
        allFiles: context.files,
        deletedPaths,
        sections,
        intro: prompt.intro,
      };
      const overhead =
        estimateTokens(system) +
        estimateTokens(composeUserPrompt({ ...promptInput, diff: "", part: 1, parts: 1 }));
      const requestCap = Math.floor(config.limits.max_total_tokens / 3);
      const inputBudget = Math.min(options.maxInputTokens ?? DEFAULT_MAX_INPUT_TOKENS, requestCap);
      const chunks = chunkDiff(task.files, Math.max(inputBudget - overhead, 500));

      // What the model was sent, for the log (FR-14 observability): request count and size in characters.
      let requests = 0;
      let requestChars = 0;

      const askChunk = async (chunk: DiffChunk, index: number): Promise<ChunkOutcome> => {
        const user = composeUserPrompt({
          ...promptInput,
          diff: chunk.text,
          part: index + 1,
          parts: chunks.length,
        });
        const usage: TokenUsage = { inputTokens: 0, outputTokens: 0 };
        let retries = 0;
        const request = (text: string) => {
          requests += 1;
          requestChars += system.length + text.length;
          return provider.complete({
            system,
            user: text,
            jsonSchema,
            maxOutputTokens: options.maxOutputTokens ?? DEFAULT_MAX_OUTPUT_TOKENS,
            timeoutMs: config.limits.request_timeout_ms,
            ...(task.signal ? { signal: task.signal } : {}),
          });
        };
        const fail = (failure: { kind: ChunkFailure; warning: string }): ChunkOutcome => ({
          findings: [],
          observations: [],
          usage,
          retries,
          failure,
        });
        const discarded = {
          kind: "invalid_output" as const,
          warning: `${label}: a response did not match the expected format and was discarded.`,
        };

        // First attempt, then at most one repair attempt that shows the model what was wrong (FR-12, FR-14).
        let previous = "";
        let problems: string[] = [];
        for (let attempt = 0; attempt < 2; attempt += 1) {
          try {
            const response = await request(
              attempt === 0 ? user : composeRepairPrompt(user, delimiterId, previous, problems),
            );
            usage.inputTokens += response.usage.inputTokens;
            usage.outputTokens += response.usage.outputTokens;
            retries += response.retries;
            const parsed = outputSchema.safeParse(response.json);
            if (parsed.success) {
              return {
                findings: parsed.data.findings.map((raw) =>
                  toFinding(raw, id, context.pr.headSha, known),
                ),
                observations: (parsed.data.observations ?? [])
                  .map((text) => truncate(text.trim(), OBSERVATION_MAX))
                  .filter(Boolean),
                usage,
                retries,
              };
            }
            previous = JSON.stringify(response.json) ?? "";
            problems = describeIssues(parsed.error.issues);
          } catch (err) {
            retries += retriesOf(err);
            if (attempt === 0 && isRepairable(err)) {
              previous = "";
              problems = [
                "The answer was not valid JSON, or it was cut off. Return a complete JSON object, with fewer findings if needed.",
              ];
            } else if (isRepairable(err)) {
              return fail(discarded);
            } else {
              return fail(failureOf(err, label));
            }
          }
          if (attempt === 0) retries += 1; // the repair request itself
        }
        return fail(discarded);
      };

      const outcomes = await Promise.all(chunks.map((chunk, i) => askChunk(chunk, i)));

      // ---- aggregate
      const usage: TokenUsage = { inputTokens: 0, outputTokens: 0 };
      let findings: Finding[] = [];
      const observations: string[] = [...preparedObservations];
      const warnings: string[] = [...preparedWarnings];
      let retries = 0;
      let failed = 0;
      const kinds = new Set<ChunkFailure>();
      for (const outcome of outcomes) {
        usage.inputTokens += outcome.usage.inputTokens;
        usage.outputTokens += outcome.usage.outputTokens;
        retries += outcome.retries;
        findings.push(...outcome.findings);
        for (const text of outcome.observations) {
          if (!observations.includes(text) && observations.length < MAX_OBSERVATIONS_PER_RESPONSE) {
            observations.push(text);
          }
        }
        if (outcome.failure) {
          failed += 1;
          kinds.add(outcome.failure.kind);
          if (outcome.failure.warning && !warnings.includes(outcome.failure.warning)) {
            warnings.push(outcome.failure.warning);
          }
        }
      }
      if (failed > 0 && chunks.length > 1) {
        warnings.push(
          `${label}: ${failed} of ${chunks.length} parts of the diff were not reviewed.`,
        );
      }

      // The agent's status is its worst chunk's, but what the good chunks found is kept.
      let status: AgentRunStatus = "ok";
      if (kinds.has("failed") || kinds.has("cancelled")) status = "failed";
      else if (kinds.has("timeout")) status = "timeout";
      else if (kinds.has("invalid_output")) status = "invalid_output";

      if (options.refine) findings = options.refine(findings, task);

      const durationMs = Math.max(0, now() - started);
      logger.info("Agent finished", {
        agent: id,
        status,
        prompt: `${prompt.id}.v${prompt.version}`,
        parts: chunks.length,
        failedParts: failed,
        findings: findings.length,
        requests,
        requestChars,
        inputTokens: usage.inputTokens,
        outputTokens: usage.outputTokens,
        retries,
        durationMs,
      });
      return {
        agent: id,
        status,
        findings,
        observations,
        ...(prepared.coverage ? { coverage: prepared.coverage } : {}),
        durationMs,
        usage,
        retries,
        warnings,
      };
    },
  };
}
