import {
  createLogger,
  type AgentRun,
  type Finding,
  type Logger,
  type ResolvedConfig,
  type TokenUsage,
} from "@ai-pr-review/shared";
import type { ReviewContext } from "../context/types";
import { governorLimits, RunGovernor } from "../providers/governor";
import { ProviderTimeout } from "../providers/errors";
import type { Provider } from "../providers/types";
import { countSuppressed, validateFindings } from "../validation/findingValidator";
import { codeReviewAgent } from "./codeReview";
import { runFinalReview, type FinalReviewOutcome } from "./finalReview";
import { securityAgent } from "./security";
import { testCoverageAgent } from "./testCoverage";
import {
  ReviewAborted,
  type Agent,
  type AgentDeps,
  type AgentResult,
  type AgentTask,
  type EngineResult,
} from "./types";

/**
 * The review agents the engine runs in parallel. Final Review (`agents.final_review`) is not one of them: it is a
 * second pass over their validated findings (see `runFinalReview`), so it runs after them.
 */
export const DEFAULT_AGENTS: readonly Agent[] = [codeReviewAgent, testCoverageAgent, securityAgent];

/** An agent that has not finished after this many request timeouts is stopped (only a safety valve). */
const AGENT_TIMEOUT_REQUESTS = 5;

export interface RunReviewOptions {
  logger?: Logger;
  /**
   * The run's governor, when the caller wants its snapshot afterwards or shares it with other work. The provider
   * passed to `runReview` must be the raw one: the engine wraps it. Without this, one is built from `limits`.
   */
  governor?: RunGovernor;
  /** The agents available to the run. Defaults to `DEFAULT_AGENTS`. */
  agents?: readonly Agent[];
  /** Per-agent deadline in milliseconds. Defaults to five request timeouts. */
  agentTimeoutMs?: number;
  /**
   * Read access to the repository through the GitHub API (an installation Octokit and the repository). The Test
   * Coverage agent uses it for the coverage artifact and existing tests; without it that agent reports coverage
   * as not available and works from the diff.
   */
  github?: AgentDeps["github"];
  randomId?: () => string;
  now?: () => number;
}

const silentLogger = createLogger({}, () => undefined);

const zeroUsage = (): TokenUsage => ({ inputTokens: 0, outputTokens: 0 });

/** Counts by reason without the zeros, as one log value ("duplicate=1,style_only=2"; "none" when empty). */
const nonZero = (counts: Record<string, number>): string =>
  Object.entries(counts)
    .filter(([, n]) => n > 0)
    .map(([reason, n]) => `${reason}=${n}`)
    .join(",") || "none";

function failedResult(
  agent: Agent,
  status: AgentResult["status"],
  warning: string,
  durationMs: number,
): AgentResult {
  return {
    agent: agent.id,
    status,
    findings: [],
    observations: [],
    durationMs,
    usage: zeroUsage(),
    retries: 0,
    warnings: [warning],
  };
}

function emptyResult(
  status: EngineResult["status"],
  reason: string,
  context: ReviewContext,
  governor: RunGovernor,
  durationMs: number,
): EngineResult {
  return {
    status,
    reason,
    findings: [],
    suppressed: [],
    suppressedCounts: countSuppressed([]),
    agentRuns: [],
    observations: [],
    warnings: [...new Set([...context.warnings, reason])],
    usage: zeroUsage(),
    governor: governor.snapshot(),
    durationMs,
  };
}

/**
 * Runs one agent with its failures contained: a throw becomes a `failed` result, a deadline a `timeout`, and
 * neither reaches the other agents. The agent gets its own signal, which fires when the run is cancelled, when
 * the deadline passes, and (for an agent that ignores signals) the engine stops waiting at the deadline anyway.
 */
async function runAgent(
  agent: Agent,
  task: Omit<AgentTask, "signal">,
  deps: AgentDeps,
  parent: AbortSignal | undefined,
  timeoutMs: number,
  now: () => number,
): Promise<AgentResult> {
  const started = now();
  const controller = new AbortController();
  const onParentAbort = () => controller.abort();
  if (parent?.aborted) controller.abort();
  else parent?.addEventListener("abort", onParentAbort, { once: true });

  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<AgentResult>((resolve) => {
    timer = setTimeout(() => {
      controller.abort();
      deps.logger.warn("Agent timed out", {
        agent: agent.id,
        status: "timeout",
        durationMs: now() - started,
      });
      resolve(
        failedResult(
          agent,
          "timeout",
          `${agent.label}: did not finish in time and was stopped.`,
          now() - started,
        ),
      );
    }, timeoutMs);
  });

  const running = agent.run({ ...task, signal: controller.signal }, deps).catch((err: unknown) => {
    // Only the error's name is logged: its message could quote code.
    deps.logger.error("Agent threw", {
      agent: agent.id,
      error: err instanceof Error ? err.name : "unknown",
    });
    return err instanceof ProviderTimeout
      ? failedResult(
          agent,
          "timeout",
          `${agent.label}: the AI provider timed out.`,
          now() - started,
        )
      : failedResult(
          agent,
          "failed",
          `${agent.label}: the review failed unexpectedly.`,
          now() - started,
        );
  });

  try {
    return await Promise.race([running, deadline]);
  } finally {
    clearTimeout(timer);
    parent?.removeEventListener("abort", onParentAbort);
  }
}

/**
 * The review engine's entry point (design §7, §10): selects the enabled agents, runs them in parallel under the
 * provider concurrency cap, validates and deduplicates what they found, and aggregates one result. It does not
 * touch the database or GitHub; the worker persists and publishes the result (Phase 8, 9).
 *
 * - `skipped`: the size policy skipped the PR, or nothing is left to review. No model is called.
 * - `failed`: every agent failed and nothing was found.
 * - `partial`: some agent failed, timed out or returned unusable output, or the size policy left files out.
 * - `completed`: otherwise.
 *
 * Throws `ReviewAborted` if `signal` fires: a cancelled or superseded run has no result to publish.
 */
export async function runReview(
  context: ReviewContext,
  config: ResolvedConfig,
  provider: Provider,
  signal?: AbortSignal,
  options: RunReviewOptions = {},
): Promise<EngineResult> {
  const now = options.now ?? Date.now;
  const started = now();
  const logger = options.logger ?? silentLogger;
  const governor = options.governor ?? new RunGovernor(governorLimits(config.limits));
  if (signal?.aborted) throw new ReviewAborted();

  if (context.limits.status === "skipped") {
    return emptyResult(
      "skipped",
      context.limits.reason ?? "The pull request is over the size limits.",
      context,
      governor,
      now() - started,
    );
  }

  // ---- select agents and assign files
  const available = options.agents ?? DEFAULT_AGENTS;
  const jobs = available
    .filter((agent) => config.agents[agent.id])
    .map((agent) => ({ agent, files: agent.selectFiles?.(context) ?? context.files }))
    .filter((job) => job.files.length > 0);
  if (jobs.length === 0) {
    const reason = available.some((agent) => config.agents[agent.id])
      ? "No file is left to review after filtering."
      : "No review agent is enabled.";
    return emptyResult("skipped", reason, context, governor, now() - started);
  }

  // ---- run
  const governed = governor.wrap(provider);
  const timeoutMs =
    options.agentTimeoutMs ?? config.limits.request_timeout_ms * AGENT_TIMEOUT_REQUESTS;
  const results = await Promise.all(
    jobs.map(({ agent, files }) =>
      runAgent(
        agent,
        { agent: agent.id, context, files, config, repoInstructions: config.instructions },
        {
          provider: governed,
          logger: logger.child({ agent: agent.id }),
          ...(options.github ? { github: options.github } : {}),
          ...(options.randomId ? { randomId: options.randomId } : {}),
          now,
        },
        signal,
        timeoutMs,
        now,
      ),
    ),
  );
  if (signal?.aborted) throw new ReviewAborted();

  // ---- validate and deduplicate across agents
  const rawFindings: Finding[] = results.flatMap((result) => result.findings);
  const validated = validateFindings(rawFindings, context, config);
  let accepted = validated.accepted;
  const suppressed = [...validated.suppressed];

  // ---- the optional second look (agents.final_review): unsupported findings are dropped and counted
  let finalReview: FinalReviewOutcome | undefined;
  if (config.agents.final_review && accepted.length > 0) {
    finalReview = await runFinalReview({
      context,
      config,
      findings: accepted,
      provider: governed,
      logger: logger.child({ agent: "final_review" }),
      signal,
      deadlineMs: timeoutMs,
      randomId: options.randomId,
      now,
    });
    if (signal?.aborted) throw new ReviewAborted();
    accepted = finalReview.approved;
    for (const finding of finalReview.rejected) {
      suppressed.push({ finding, reason: "rejected_by_final_review" });
    }
  }
  const suppressedCounts = countSuppressed(suppressed);

  // ---- aggregate
  const agentRuns: AgentRun[] = results.map((result) => ({
    agent: result.agent,
    status: result.status,
    startedAt: new Date(started).toISOString(),
    durationMs: result.durationMs,
    usage: result.usage,
    retries: result.retries,
    warnings: result.warnings,
  }));
  if (finalReview) {
    agentRuns.push({
      agent: "final_review",
      status: finalReview.status,
      startedAt: new Date(now() - finalReview.durationMs).toISOString(),
      durationMs: finalReview.durationMs,
      usage: finalReview.usage,
      retries: finalReview.retries,
      warnings: finalReview.warnings,
    });
  }
  const usage = [
    ...results.map((r) => r.usage),
    ...(finalReview ? [finalReview.usage] : []),
  ].reduce<TokenUsage>(
    (sum, u) => ({
      inputTokens: sum.inputTokens + u.inputTokens,
      outputTokens: sum.outputTokens + u.outputTokens,
    }),
    zeroUsage(),
  );

  const limited = context.limits.status === "limited";
  const okAgents = results.filter((r) => r.status === "ok").length;
  const primaryStatus =
    okAgents === 0 && rawFindings.length === 0
      ? "failed"
      : okAgents < results.length || limited
        ? "partial"
        : "completed";
  // A second look that did not finish leaves findings that were not double-checked: say so with `partial`.
  const status =
    primaryStatus === "completed" && finalReview && finalReview.status !== "ok"
      ? "partial"
      : primaryStatus;

  const warnings = [
    ...new Set([
      ...context.warnings,
      ...(limited && context.limits.reason ? [context.limits.reason] : []),
      ...results.flatMap((r) => r.warnings),
      ...(finalReview?.warnings ?? []),
    ]),
  ];
  const coverage = results.find((r) => r.coverage)?.coverage;

  const result: EngineResult = {
    status,
    ...(status === "failed" ? { reason: "Every review agent failed." } : {}),
    ...(limited && context.limits.reason && status !== "failed"
      ? { reason: context.limits.reason }
      : {}),
    findings: accepted,
    suppressed,
    suppressedCounts,
    agentRuns,
    observations: results.flatMap((r) => r.observations.map((text) => ({ agent: r.agent, text }))),
    ...(coverage ? { coverage } : {}),
    ...(finalReview ? { finalReview: finalReview.summary } : {}),
    warnings,
    usage,
    governor: governor.snapshot(),
    durationMs: now() - started,
  };
  logger.info("Review finished", {
    status,
    agents: results.length,
    findings: accepted.length,
    suppressed: suppressed.length,
    suppressedByReason: nonZero(suppressedCounts),
    requests: result.governor.requests,
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    durationMs: result.durationMs,
  });
  return result;
}
