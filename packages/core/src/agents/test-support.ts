import { createLogger, type Finding, type Logger, type RawConfig } from "@ai-pr-review/shared";
import { collectContext } from "../context/collect";
import {
  createFakeGitHub,
  DASHBOARD,
  type FakeFile,
  type FakeGitHubSetup,
  type FakePull,
} from "../context/test-support";
import type { ReviewContext } from "../context/types";
import type { ReviewFixture } from "./codeReview/fixtures";

// Helpers for the agent, validator and orchestrator tests. Not exported from the package.

export const HEAD_SHA = "a".repeat(40);

/** A real `ReviewContext`, collected from a fake GitHub, so the tests run on the same objects the worker will. */
export async function buildContext(
  files: FakeFile[],
  options: {
    config?: RawConfig;
    pull?: FakePull;
    setup?: Omit<FakeGitHubSetup, "files" | "pull">;
  } = {},
): Promise<ReviewContext> {
  const github = createFakeGitHub({ ...options.setup, files, pull: options.pull ?? {} });
  return collectContext({
    octokit: github.client,
    repo: { owner: "acme", repo: "widgets" },
    prNumber: 7,
    config: { ...DASHBOARD, ...options.config },
  });
}

export const fixtureContext = (
  fixture: ReviewFixture,
  config?: RawConfig,
): Promise<ReviewContext> =>
  buildContext(fixture.files, {
    pull: { title: fixture.title, body: fixture.body },
    ...(config ? { config } : {}),
  });

/** A finding as the agent would hand it over, for validator tests. */
export function makeFinding(over: Partial<Finding> = {}): Finding {
  return {
    id: "0123456789abcdef",
    agent: "code_review",
    category: "bug",
    severity: "high",
    confidence: 0.9,
    title: "Something is wrong",
    evidence: "const x = y;",
    impact: "The result is wrong for empty input.",
    recommendation: "Check for empty input.",
    sourceCommitSha: HEAD_SHA,
    ...over,
  };
}

/** A model answer in the schema's own (snake_case) shape. */
export function modelFinding(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    category: "bug",
    severity: "high",
    confidence: 0.92,
    title: "Problem",
    file_path: null,
    start_line: null,
    end_line: null,
    evidence: "code",
    impact: "It breaks.",
    recommendation: "Fix it.",
    suggested_test: null,
    ...over,
  };
}

export const answer = (...findings: Record<string, unknown>[]) => ({
  findings,
  observations: [] as string[],
});

/** A logger that keeps every line, to check what reaches the logs. */
export function capturingLogger(): { logger: Logger; lines: string[] } {
  const lines: string[] = [];
  return { logger: createLogger({}, (line) => lines.push(line)), lines };
}

/** A fixed, predictable delimiter id source. */
export function sequentialIds(prefix = "testid"): () => string {
  let n = 0;
  return () => `${prefix}${String(++n).padStart(6, "0")}`;
}
