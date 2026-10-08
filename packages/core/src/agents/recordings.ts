// Recorded real-provider runs (Phase 16): what a real model answered to the fixture pull requests, kept as files so
// that a change to the validator, the publisher or the prompts can be checked against real answers without a key.
//
//   - `npm run review:fixtures` with RECORD=1 sends the fixtures to a real provider and writes one file per fixture
//     under `fixtures/recorded/` (`scripts/smoke-review.ts`).
//   - `recordings.test.ts` replays every file through the whole engine with a mock provider that returns the
//     recorded answers in order, and checks the outcome is the one recorded.
//   - Each recording holds a hash of every request. When a prompt (or the way the diff is rendered) changes, the
//     replayed requests no longer match: the recording is **stale**. The old answers still test the code downstream
//     of the model, but they no longer test the prompt, so the file must be recorded again and compared by a person
//     (docs/pilot.md, "Tuning"). `RECORDINGS_MUST_BE_FRESH=1` turns a stale recording into a test failure; the
//     release check sets it.
//
// A recording holds model answers about the repository's own fixture code. It holds no key and no user data.
import { createHash } from "node:crypto";
import { mergeConfig, type ReviewResult } from "@ai-pr-review/shared";
import { createMockProvider } from "../providers/mock";
import type { Provider, ProviderName, ProviderRequest } from "../providers/types";
import { runReview } from "./orchestrator";
import type { ExpectedFinding, FixtureReply } from "./codeReview/fixtures";
import { buildContext, sequentialIds } from "./test-support";
import type { FakeFile } from "../context/test-support";

export type RecordedAgent = "code_review" | "security";

/** The parts of a Code Review or Security fixture that a run needs. */
export interface RunnableFixture {
  name: string;
  title: string;
  body: string;
  files: FakeFile[];
  expected: ExpectedFinding[];
  reply?: FixtureReply;
}

export interface Outcome {
  status: string;
  /** Expected findings that were reported, and how many were expected. */
  found: number;
  expected: number;
  /** Accepted findings that were not expected. */
  extra: number;
  suppressed: number;
}

export interface Recording {
  version: 1;
  agent: RecordedAgent;
  fixture: string;
  provider: string;
  model: string;
  recordedAt: string;
  /** SHA-256 of each request (system prompt, a separator, user message), in the order the requests were made. */
  requestHashes: string[];
  /** The JSON each request was answered with, in order. */
  replies: unknown[];
  outcome: Outcome;
}

export const hashRequest = (req: Pick<ProviderRequest, "system" | "user">): string =>
  createHash("sha256").update(req.system).update("\u0000").update(req.user).digest("hex");

/** Wraps a provider and keeps what it was asked and what it answered. */
export function recordingProvider(inner: Provider): {
  provider: Provider;
  requestHashes: string[];
  replies: unknown[];
} {
  const requestHashes: string[] = [];
  const replies: unknown[] = [];
  return {
    requestHashes,
    replies,
    provider: {
      name: inner.name,
      model: inner.model,
      async complete(req) {
        const response = await inner.complete(req);
        requestHashes.push(hashRequest(req));
        replies.push(response.json);
        return response;
      },
    },
  };
}

/** How a result compares with what the fixture says a good review reports (the same scoring `review:fixtures` prints). */
export function scoreResult(
  fixture: Pick<RunnableFixture, "expected">,
  result: Pick<ReviewResult, "status" | "findings"> & { suppressed: readonly unknown[] },
): Outcome {
  const found = fixture.expected.filter((e) =>
    result.findings.some(
      (f) =>
        f.filePath === e.path &&
        Math.abs((f.startLine ?? -99) - e.line) <= e.tolerance &&
        f.category === e.category,
    ),
  ).length;
  return {
    status: result.status,
    found,
    expected: fixture.expected.length,
    extra: Math.max(0, result.findings.length - found),
    suppressed: result.suppressed.length,
  };
}

/** One agent at a time, so the answer being scored is that agent's own. */
const configFor = (agent: RecordedAgent, provider: string, model: string) =>
  mergeConfig({
    provider: provider as ProviderName,
    model,
    agents: {
      code_review: agent === "code_review",
      test_coverage: false,
      security: agent === "security",
    },
  });

async function review(fixture: RunnableFixture, agent: RecordedAgent, provider: Provider) {
  const context = await buildContext(fixture.files, {
    pull: { title: fixture.title, body: fixture.body },
  });
  // Fixed delimiter ids, so the same fixture produces the same request every time (and the hashes can be compared).
  return runReview(context, configFor(agent, provider.name, provider.model), provider, undefined, {
    randomId: sequentialIds("rec"),
  });
}

/** Runs a fixture against `provider` (a real one, when recording) and returns the recording of what happened. */
export async function recordFixture(
  fixture: RunnableFixture,
  agent: RecordedAgent,
  provider: Provider,
  now: () => Date = () => new Date(),
): Promise<{ recording: Recording; result: Awaited<ReturnType<typeof review>> }> {
  const tape = recordingProvider(provider);
  const result = await review(fixture, agent, tape.provider);
  return {
    result,
    recording: {
      version: 1,
      agent,
      fixture: fixture.name,
      provider: provider.name,
      model: provider.model,
      recordedAt: now().toISOString(),
      requestHashes: tape.requestHashes,
      replies: tape.replies,
      outcome: scoreResult(fixture, result),
    },
  };
}

/** Replays a recording through the current engine. `stale` says the requests are no longer the recorded ones. */
export async function replayRecording(
  fixture: RunnableFixture,
  recording: Recording,
): Promise<{ outcome: Outcome; stale: boolean; staleReason?: string }> {
  const mock = createMockProvider({
    name: recording.provider as Provider["name"],
    model: recording.model,
    replies: recording.replies as never[],
  });
  const result = await review(fixture, recording.agent, mock);
  const hashes = mock.calls.map(hashRequest);
  const same =
    hashes.length === recording.requestHashes.length &&
    hashes.every((h, i) => h === recording.requestHashes[i]);
  return {
    outcome: scoreResult(fixture, result),
    stale: !same,
    ...(same
      ? {}
      : {
          staleReason:
            hashes.length === recording.requestHashes.length
              ? "the requests differ from the recorded ones (a prompt or the diff rendering changed)"
              : `the engine now makes ${hashes.length} request(s), the recording has ${recording.requestHashes.length}`,
        }),
  };
}

/** Where a recording lives, relative to `fixtures/recorded`. */
export function recordingFileName(
  r: Pick<Recording, "agent" | "provider" | "model" | "fixture">,
): string {
  const safe = (s: string) => s.replace(/[^a-zA-Z0-9._-]+/g, "-");
  return `${r.agent}/${safe(`${r.provider}-${r.model}`)}/${safe(r.fixture)}.json`;
}
