import type {
  AgentRunStatus,
  FinalReviewSummary,
  Finding,
  Logger,
  ResolvedConfig,
  TokenUsage,
} from "@ai-pr-review/shared";
import { z } from "zod";
import { estimateTokens } from "../../context/size";
import type { ReviewContext } from "../../context/types";
import { FINAL_REVIEW_PROMPT } from "../../prompts/finalReview.v1";
import {
  composeRepairPrompt,
  composeSystemPrompt,
  createDelimiterId,
  wrapUntrusted,
} from "../../prompts";
import type { Provider } from "../../providers/types";
import { renderExcerpt } from "../diff-render";
import {
  DEFAULT_MAX_INPUT_TOKENS,
  describeIssues,
  failureOf,
  isRepairable,
  retriesOf,
  type ChunkFailure,
} from "../structured";

// The optional Final Review pass (Phase 13, `agents.final_review`). The review agents propose findings; this pass
// reads each one next to the diff it is about and rejects what the code does not support. It runs after the
// validator, once, over the findings that would otherwise be published. It cannot add findings or change them,
// and it fails open: whatever it could not check is kept, with a warning, because a lost real finding is worse
// than an extra one.

/** Findings checked in one request. The most severe come first; the rest are kept without a second look. */
export const FINAL_REVIEW_MAX_FINDINGS = 30;
/** Rendered diff lines shown either side of a finding's line, then fewer when the request would be too large. */
const EXCERPT_RADIUS = [12, 5, 2] as const;
const EXCERPT_MAX_CHARS = 3_000;
const FIELD_MAX_CHARS = 600;
const MAX_OUTPUT_TOKENS = 2_048;

const verdictSchema = z.object({
  verdicts: z
    .array(
      z.object({
        id: z.string(),
        verdict: z.enum(["approve", "reject"]),
        reason: z.string().nullish(),
      }),
    )
    .max(FINAL_REVIEW_MAX_FINDINGS * 2),
});

const jsonSchema = {
  type: "object",
  additionalProperties: false,
  required: ["verdicts"],
  properties: {
    verdicts: {
      type: "array",
      description: "One entry per proposed finding.",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["id", "verdict", "reason"],
        properties: {
          id: { type: "string", description: "The finding's id as given, such as F1." },
          verdict: { type: "string", enum: ["approve", "reject"] },
          reason: {
            type: "string",
            description: "One short sentence naming what in the excerpt supports the verdict.",
          },
        },
      },
    },
  },
};

export interface FinalReviewInput {
  context: ReviewContext;
  config: ResolvedConfig;
  /** Validated findings, most severe first. */
  findings: readonly Finding[];
  provider: Provider;
  logger: Logger;
  signal?: AbortSignal | undefined;
  /** The pass is stopped after this long (milliseconds). */
  deadlineMs: number;
  randomId?: (() => string) | undefined;
  now?: (() => number) | undefined;
}

export interface FinalReviewOutcome {
  status: AgentRunStatus;
  /** Findings that stay, in their original order (rejected ones removed). */
  approved: Finding[];
  rejected: Finding[];
  summary: FinalReviewSummary;
  usage: TokenUsage;
  retries: number;
  durationMs: number;
  /** Fixed sentences for the summary (never model output). */
  warnings: string[];
}

const clip = (text: string, max: number): string =>
  text.length <= max ? text : `${text.slice(0, max - 1)}…`;

/** One finding as the reviewer reads it: our id, its own words, and the excerpt of the diff it points at. */
function entry(id: string, finding: Finding, context: ReviewContext, radius: number): string {
  const file =
    finding.filePath === undefined
      ? undefined
      : context.files.find((f) => f.path === finding.filePath);
  const excerpt = file
    ? clip(renderExcerpt(file, finding.startLine, radius), EXCERPT_MAX_CHARS)
    : "";
  const where =
    finding.filePath === undefined
      ? "(no location)"
      : `${finding.filePath}${finding.startLine === undefined ? "" : `:${finding.startLine}`}`;
  return [
    `### ${id}`,
    `Severity: ${finding.severity} · Confidence: ${finding.confidence.toFixed(2)} · Category: ${finding.category}`,
    `Location: ${where}`,
    `Title: ${clip(finding.title, FIELD_MAX_CHARS)}`,
    `Evidence: ${clip(finding.evidence, FIELD_MAX_CHARS)}`,
    `Impact: ${clip(finding.impact, FIELD_MAX_CHARS)}`,
    `Diff excerpt:\n${excerpt === "" ? "(none)" : excerpt}`,
  ].join("\n");
}

/** The user message for the findings it can afford, with the most compact excerpts that fit. */
function composeRequest(
  findings: readonly Finding[],
  context: ReviewContext,
  delimiterId: string,
  budgetTokens: number,
): { user: string; ids: string[] } {
  const build = (subset: readonly Finding[], radius: number) => {
    const ids = subset.map((_, i) => `F${i + 1}`);
    const body = [
      `## Pull request title\n${context.pr.title.trim() || "(none)"}`,
      `## Proposed findings\n${subset.map((f, i) => entry(ids[i]!, f, context, radius)).join("\n\n")}`,
    ].join("\n\n");
    const user = [
      FINAL_REVIEW_PROMPT.intro ?? "",
      "",
      wrapUntrusted(delimiterId, body),
      "",
      "Answer with the JSON object only.",
    ].join("\n");
    return { user, ids };
  };
  for (const radius of EXCERPT_RADIUS) {
    const attempt = build(findings, radius);
    if (estimateTokens(attempt.user) <= budgetTokens) return attempt;
  }
  // Even the smallest excerpts do not fit: ask about as many findings as do.
  let count = findings.length;
  while (count > 1) {
    count -= 1;
    const attempt = build(findings.slice(0, count), EXCERPT_RADIUS[2]);
    if (estimateTokens(attempt.user) <= budgetTokens) return attempt;
  }
  return build(findings.slice(0, 1), EXCERPT_RADIUS[2]);
}

const emptyUsage = (): TokenUsage => ({ inputTokens: 0, outputTokens: 0 });

/**
 * Runs the pass. Never throws for a provider failure: a timeout, a bad answer or an unavailable provider keeps
 * every finding and says so. A cancelled run is reported as `failed`; the caller checks the signal.
 */
export async function runFinalReview(input: FinalReviewInput): Promise<FinalReviewOutcome> {
  const { context, config, provider, logger } = input;
  const now = input.now ?? Date.now;
  const started = now();
  const label = "Final Review";

  const candidates = input.findings.slice(0, FINAL_REVIEW_MAX_FINDINGS);
  const outcome = (
    status: AgentRunStatus,
    rejected: readonly Finding[],
    checked: number,
    usage: TokenUsage,
    retries: number,
    warnings: string[],
    requests: number,
    requestChars: number,
  ): FinalReviewOutcome => {
    const rejectedSet = new Set(rejected);
    const approved = input.findings.filter((f) => !rejectedSet.has(f));
    const durationMs = Math.max(0, now() - started);
    const summary: FinalReviewSummary = {
      status,
      reviewed: checked,
      approved: Math.max(0, checked - rejected.length),
      rejected: rejected.length,
      unreviewed: input.findings.length - checked,
    };
    logger.info("Agent finished", {
      agent: "final_review",
      status,
      prompt: `${FINAL_REVIEW_PROMPT.id}.v${FINAL_REVIEW_PROMPT.version}`,
      reviewed: summary.reviewed,
      approved: summary.approved,
      rejected: summary.rejected,
      unreviewed: summary.unreviewed,
      requests,
      requestChars,
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      retries,
      durationMs,
    });
    return {
      status,
      approved,
      rejected: [...rejected],
      summary,
      usage,
      retries,
      durationMs,
      warnings,
    };
  };

  if (candidates.length === 0) {
    return outcome("ok", [], 0, emptyUsage(), 0, [], 0, 0);
  }

  const delimiterId = createDelimiterId(
    [
      context.pr.title,
      ...candidates.flatMap((f) => [f.title, f.evidence, f.impact, f.filePath ?? ""]),
      ...context.files.map((f) => f.patch ?? ""),
    ],
    input.randomId,
  );
  const system = composeSystemPrompt(FINAL_REVIEW_PROMPT, delimiterId);
  const budget = Math.min(DEFAULT_MAX_INPUT_TOKENS, Math.floor(config.limits.max_total_tokens / 3));
  const request = composeRequest(
    candidates,
    context,
    delimiterId,
    Math.max(budget - estimateTokens(system), 500),
  );
  const checked = request.ids.length;

  // The pass has its own deadline and its own signal, so a stuck model cannot hold the whole run.
  const controller = new AbortController();
  const abort = () => controller.abort();
  if (input.signal?.aborted) controller.abort();
  else input.signal?.addEventListener("abort", abort, { once: true });
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<"deadline">((resolve) => {
    timer = setTimeout(() => {
      controller.abort();
      resolve("deadline");
    }, input.deadlineMs);
  });

  const usage = emptyUsage();
  let retries = 0;
  let requests = 0;
  let requestChars = 0;

  const ask = async (): Promise<
    | { ok: true; verdicts: Map<string, "approve" | "reject"> }
    | { ok: false; failure: { kind: ChunkFailure; warning: string } }
  > => {
    let previous = "";
    let problems: string[] = [];
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const user =
        attempt === 0
          ? request.user
          : composeRepairPrompt(request.user, delimiterId, previous, problems);
      try {
        requests += 1;
        requestChars += system.length + user.length;
        const response = await provider.complete({
          system,
          user,
          jsonSchema,
          maxOutputTokens: MAX_OUTPUT_TOKENS,
          timeoutMs: config.limits.request_timeout_ms,
          signal: controller.signal,
        });
        usage.inputTokens += response.usage.inputTokens;
        usage.outputTokens += response.usage.outputTokens;
        retries += response.retries;
        const parsed = verdictSchema.safeParse(response.json);
        if (parsed.success) {
          return {
            ok: true,
            verdicts: new Map(parsed.data.verdicts.map((v) => [v.id, v.verdict] as const)),
          };
        }
        previous = JSON.stringify(response.json) ?? "";
        problems = describeIssues(parsed.error.issues);
      } catch (err) {
        retries += retriesOf(err);
        if (attempt === 0 && isRepairable(err)) {
          previous = "";
          problems = [
            "The answer was not valid JSON, or it was cut off. Return a complete JSON object.",
          ];
        } else if (isRepairable(err)) {
          break;
        } else {
          return { ok: false, failure: failureOf(err, label) };
        }
      }
      if (attempt === 0) retries += 1; // the repair request itself
    }
    return {
      ok: false,
      failure: {
        kind: "invalid_output",
        warning: `${label}: a response did not match the expected format and was discarded.`,
      },
    };
  };

  try {
    const answer = await Promise.race([ask(), deadline]);
    if (answer === "deadline") {
      return outcome(
        "timeout",
        [],
        checked,
        usage,
        retries,
        [`${label}: did not finish in time, so the findings were not double-checked.`],
        requests,
        requestChars,
      );
    }
    if (!answer.ok) {
      const status: AgentRunStatus =
        answer.failure.kind === "timeout"
          ? "timeout"
          : answer.failure.kind === "invalid_output"
            ? "invalid_output"
            : "failed";
      return outcome(
        status,
        [],
        checked,
        usage,
        retries,
        [
          ...(answer.failure.warning ? [answer.failure.warning] : []),
          `${label}: the findings were not double-checked and are listed as found.`,
        ],
        requests,
        requestChars,
      );
    }
    // Only an explicit rejection of a finding we asked about removes it; a missing verdict keeps it.
    const rejected = candidates
      .slice(0, checked)
      .filter((_, i) => answer.verdicts.get(request.ids[i]!) === "reject");
    return outcome("ok", rejected, checked, usage, retries, [], requests, requestChars);
  } finally {
    clearTimeout(timer);
    input.signal?.removeEventListener("abort", abort);
  }
}
