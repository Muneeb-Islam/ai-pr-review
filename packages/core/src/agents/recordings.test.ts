// Recorded real-provider runs (Phase 16, packages/core/src/agents/recordings.ts): the machinery works, and every
// recording kept in fixtures/recorded still gives the outcome it was recorded with.
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";
import { createMockProvider } from "../providers/mock";
import { REVIEW_FIXTURES } from "./codeReview/fixtures";
import {
  hashRequest,
  recordFixture,
  recordingFileName,
  replayRecording,
  scoreResult,
  type RunnableFixture,
  type Recording,
} from "./recordings";
import { SECURITY_FIXTURES } from "./security/fixtures";

const ROOT = new URL("../../../../fixtures/recorded/", import.meta.url).pathname.replace(
  /^\/([A-Za-z]:)/,
  "$1",
);

function recordingFiles(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return recordingFiles(path);
    return name.endsWith(".json") ? [path] : [];
  });
}

const fixtureFor = (r: Recording): RunnableFixture | undefined =>
  (r.agent === "security" ? SECURITY_FIXTURES : REVIEW_FIXTURES).find((f) => f.name === r.fixture);

describe("recording and replaying a fixture", () => {
  const fixture = REVIEW_FIXTURES.find((f) => f.expected.length > 0)!;

  it("records what the provider answered and how the review came out", async () => {
    const provider = createMockProvider({ model: "fake-model", replies: [fixture.reply] });
    const { recording, result } = await recordFixture(
      fixture,
      "code_review",
      provider,
      () => new Date("2026-10-07T00:00:00Z"),
    );
    expect(recording).toMatchObject({
      version: 1,
      agent: "code_review",
      fixture: fixture.name,
      model: "fake-model",
      recordedAt: "2026-10-07T00:00:00.000Z",
    });
    expect(recording.replies).toEqual([fixture.reply]);
    expect(recording.requestHashes).toEqual(provider.calls.map(hashRequest));
    expect(recording.outcome).toEqual(scoreResult(fixture, result));
    expect(recording.outcome.found).toBe(fixture.expected.length);
  });

  it("replays to the same outcome, and says nothing is stale while the requests are the same", async () => {
    const provider = createMockProvider({ model: "fake-model", replies: [fixture.reply] });
    const { recording } = await recordFixture(fixture, "code_review", provider);
    const replay = await replayRecording(fixture, recording);
    expect(replay.outcome).toEqual(recording.outcome);
    expect(replay.stale).toBe(false);
  });

  it("flags a recording as stale when the requests changed (a prompt was edited), and still replays the answers", async () => {
    const provider = createMockProvider({ model: "fake-model", replies: [fixture.reply] });
    const { recording } = await recordFixture(fixture, "code_review", provider);
    const edited = {
      ...recording,
      requestHashes: recording.requestHashes.map(() => "0".repeat(64)),
    };
    const replay = await replayRecording(fixture, edited);
    expect(replay.stale).toBe(true);
    expect(replay.staleReason).toContain("prompt");
    expect(replay.outcome).toEqual(recording.outcome);
  });

  it("names files by agent, provider and model", () => {
    expect(
      recordingFileName({
        agent: "security",
        provider: "deepseek",
        model: "deepseek/v4 pro",
        fixture: "sql-injection",
      }),
    ).toBe("security/deepseek-deepseek-v4-pro/sql-injection.json");
  });
});

describe("the recordings kept in fixtures/recorded", () => {
  const files = recordingFiles(ROOT);

  it("explain themselves", () => {
    expect(existsSync(join(ROOT, "README.md"))).toBe(true);
  });

  for (const file of files) {
    const label = relative(ROOT, file).replaceAll("\\", "/");
    it(`${label} still gives the outcome it was recorded with`, async () => {
      const recording = JSON.parse(readFileSync(file, "utf8")) as Recording;
      expect(recording.version).toBe(1);
      const fixture = fixtureFor(recording);
      expect(fixture, `a fixture named ${recording.fixture}`).toBeDefined();
      const replay = await replayRecording(fixture!, recording);
      // The answers are real; the code after the model is ours. If it changed what these answers produce, that is
      // a regression or a decision, and a person decides which.
      expect(replay.outcome).toEqual(recording.outcome);
      if (process.env["RECORDINGS_MUST_BE_FRESH"]) {
        expect(
          replay.stale,
          `${label} is stale: ${replay.staleReason}. Record it again (docs/pilot.md).`,
        ).toBe(false);
      }
    });
  }
});
