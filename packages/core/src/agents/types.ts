import type {
  AgentId,
  AgentRun,
  AgentRunStatus,
  CoverageSummary,
  FinalReviewSummary,
  Finding,
  Logger,
  ResolvedConfig,
  ReviewStatus,
  SuppressReason,
  TokenUsage,
} from "@ai-pr-review/shared";
import type { ContextClient } from "../context/github";
import type { ChangedFile, ReviewContext } from "../context/types";
import type { RepoRef } from "../github/client";
import type { GovernorSnapshot } from "../providers/governor";
import type { Provider } from "../providers/types";
import type { SuppressedFinding } from "../validation/findingValidator";

// Agent contract (design §10). New agents, and scanners behind them, register against these types.

export interface AgentTask {
  agent: AgentId;
  context: ReviewContext;
  /** The files this agent should look at; chosen by the orchestrator from `context.files`. */
  files: ChangedFile[];
  config: ResolvedConfig;
  repoInstructions?: string;
  signal?: AbortSignal;
}

/** What the Test Coverage agent measured (FR-22, FR-23); persisted on the run and shown in the summary. */
export type AgentCoverage = CoverageSummary;

export interface AgentResult {
  agent: AgentId;
  status: AgentRunStatus;
  /** Normalised and fingerprinted but not yet validated against the diff or the thresholds. */
  findings: Finding[];
  observations: string[];
  coverage?: AgentCoverage;
  durationMs: number;
  usage: TokenUsage;
  retries: number;
  /** Non-sensitive sentences for the summary (FR-14). Never model output, code or keys. */
  warnings: string[];
}

export interface AgentDeps {
  provider: Provider;
  logger: Logger;
  /** Delimiter id source; tests inject a fixed one. */
  randomId?: () => string;
  /** Clock for durations; tests inject a fake. */
  now?: () => number;
  /**
   * Read access to the repository through the GitHub API (an installation Octokit), for agents that look at more
   * than the diff: the Test Coverage agent reads the coverage artifact and existing tests. Without it they work
   * from the diff alone.
   */
  github?: { client: ContextClient; repo: RepoRef };
}

export interface Agent {
  readonly id: AgentId;
  /** Human name used in warnings ("Code Review"). */
  readonly label: string;
  /** Which of the context's files this agent reviews. Defaults to all of them. */
  selectFiles?(context: ReviewContext): ChangedFile[];
  run(task: AgentTask, deps: AgentDeps): Promise<AgentResult>;
}

export type EngineStatus = ReviewStatus;

export interface EngineResult {
  /**
   * `completed`: every agent finished. `partial`: some agent failed, timed out or returned unusable output, or
   * the size policy left files out. `failed`: every agent failed. `skipped`: nothing to review (size policy,
   * or no file left after filtering); no model was called.
   */
  status: EngineStatus;
  /** Why the run is `skipped` (or why it is limited). */
  reason?: string;
  /** Validated, deduplicated findings, most severe first. These are the only findings that may be posted. */
  findings: Finding[];
  suppressed: SuppressedFinding[];
  suppressedCounts: Record<SuppressReason, number>;
  /** One per agent that ran: status, duration, tokens, retries, warnings (design §5 `agent_runs`). */
  agentRuns: AgentRun[];
  /** Notes for the summary that are not findings, with the agent that wrote them. */
  observations: Array<{ agent: AgentId; text: string }>;
  coverage?: AgentCoverage;
  /** What the optional Final Review pass did; absent when it did not run. */
  finalReview?: FinalReviewSummary;
  /** Context warnings plus every agent's, without duplicates. */
  warnings: string[];
  usage: TokenUsage;
  /** Requests and tokens as the run governor counted them, for `review_runs.usage`. */
  governor: GovernorSnapshot;
  durationMs: number;
}

/** Thrown by the engine when the caller's signal fired: the run was cancelled or superseded and has no result. */
export class ReviewAborted extends Error {
  constructor() {
    super("The review was aborted.");
    this.name = "ReviewAborted";
  }
}
