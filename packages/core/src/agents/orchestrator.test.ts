import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { findingSchema, type AgentId } from "@ai-pr-review/shared";
import { describe, expect, it } from "vitest";
import { file, makeConfig, manyFiles, patch } from "../context/test-support";
import { ProviderTimeout } from "../providers/errors";
import { RunGovernor, governorLimits } from "../providers/governor";
import { createMockProvider, type MockReply } from "../providers/mock";
import { createLlmAgent } from "./structured";
import { CODE_REVIEW_PROMPT } from "../prompts";
import { REVIEW_FIXTURES } from "./codeReview/fixtures";
import { codeReviewAgent } from "./codeReview";
import { runReview } from "./orchestrator";
import {
  answer,
  buildContext,
  capturingLogger,
  fixtureContext,
  modelFinding,
} from "./test-support";
import { ReviewAborted, type Agent, type AgentResult } from "./types";

// These tests are about orchestration and the Code Review agent; the Test Coverage agent has its own tests.
// Code Review only, so these tests count its model calls; Test Coverage and Security have their own test files.
const config = makeConfig({ agents: { test_coverage: false, security: false } });
const RAW = { provider: "deepseek", model: "test-model" } as const;

const okResult = (agent: AgentId, over: Partial<AgentResult> = {}): AgentResult => ({
  agent,
  status: "ok",
  findings: [],
  observations: [],
  durationMs: 1,
  usage: { inputTokens: 10, outputTokens: 5 },
  retries: 0,
  warnings: [],
  ...over,
});

function fakeAgent(
  id: AgentId,
  run: Agent["run"],
  extra: Partial<Pick<Agent, "selectFiles">> = {},
): Agent {
  return { id, label: id, run, ...extra };
}

const bugOn = (path: string, line: number, title = "A real bug") =>
  modelFinding({ title, file_path: path, start_line: line, end_line: line });

describe("runReview: fixtures (seeded bugs, clean and style-only changes)", () => {
  it.each(REVIEW_FIXTURES.map((fixture) => [fixture.name, fixture] as const))(
    "%s",
    async (_name, fixture) => {
      const context = await fixtureContext(fixture);
      const provider = createMockProvider({ replies: [fixture.reply] });
      const result = await runReview(context, config, provider);

      expect(result.status).toBe("completed");
      expect(result.findings).toHaveLength(fixture.expected.length);
      for (const expected of fixture.expected) {
        const match = result.findings.find(
          (f) =>
            f.filePath === expected.path &&
            Math.abs((f.startLine ?? -99) - expected.line) <= expected.tolerance &&
            f.category === expected.category,
        );
        expect(
          match,
          `${fixture.name}: expected a finding near ${expected.path}:${expected.line}`,
        ).toBeDefined();
        expect(match?.evidence.length).toBeGreaterThan(0);
        expect(match?.impact.length).toBeGreaterThan(0);
      }
      for (const finding of result.findings) {
        expect(findingSchema.safeParse(finding).success).toBe(true);
      }
      expect(provider.calls).toHaveLength(1);
    },
  );

  it("finds the seeded bug on exactly the seeded line", async () => {
    const fixture = REVIEW_FIXTURES.find((f) => f.name === "off-by-one-loop")!;
    const result = await runReview(
      await fixtureContext(fixture),
      config,
      createMockProvider({ replies: [fixture.reply] }),
    );
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0]).toMatchObject({
      filePath: "src/totals.ts",
      startLine: 3,
      severity: "high",
      category: "bug",
    });
  });

  it("filters the style nit and the low-confidence guess, and counts them by reason", async () => {
    const run = async (name: string) => {
      const fixture = REVIEW_FIXTURES.find((f) => f.name === name)!;
      return runReview(
        await fixtureContext(fixture),
        config,
        createMockProvider({ replies: [fixture.reply] }),
      );
    };
    const style = await run("style-only");
    expect(style.findings).toEqual([]);
    expect(style.suppressedCounts.style_only).toBe(1);
    const clean = await run("clean-helper");
    expect(clean.findings).toEqual([]);
    expect(clean.suppressedCounts.below_threshold).toBe(1);
    expect(clean.observations.map((o) => o.agent)).toEqual(["code_review"]);
  });
});

describe("runReview: model outputs", () => {
  async function review(replies: MockReply[], files = [file("src/a.ts")]) {
    const context = await buildContext(files);
    const provider = createMockProvider({ replies });
    const result = await runReview(context, config, provider);
    return { result, provider };
  }

  it("accepts valid findings", async () => {
    const { result } = await review([answer(bugOn("src/a.ts", 2))]);
    expect(result.status).toBe("completed");
    expect(result.findings).toHaveLength(1);
    expect(result.suppressed).toEqual([]);
  });

  it("drops malformed output with a warning and still completes the run as partial", async () => {
    const { result, provider } = await review(["not json {", { findings: "no" }]);
    expect(provider.calls).toHaveLength(2); // one repair attempt, no more
    expect(result.findings).toEqual([]);
    expect(result.status).toBe("failed");
    expect(result.warnings.join(" ")).toContain("did not match the expected format");
  });

  it("drops a finding outside the diff and counts it", async () => {
    const { result } = await review([
      answer(
        bugOn("src/a.ts", 2),
        bugOn("src/a.ts", 50, "Beyond the diff"),
        bugOn("src/elsewhere.ts", 1, "Wrong file"),
      ),
    ]);
    expect(result.findings.map((f) => f.startLine)).toEqual([2]);
    expect(result.suppressedCounts.invalid_line).toBe(2);
  });

  it("keeps one of duplicate findings", async () => {
    const { result } = await review([
      answer(bugOn("src/a.ts", 2, "Same problem"), bugOn("src/a.ts", 2, "same  PROBLEM!")),
    ]);
    expect(result.findings).toHaveLength(1);
    expect(result.suppressedCounts.duplicate).toBe(1);
  });

  it("drops low-confidence and low-severity findings below the configured thresholds", async () => {
    const { result } = await review([
      answer(
        modelFinding({ ...bugOn("src/a.ts", 1, "Unsure"), confidence: 0.5 }),
        modelFinding({ ...bugOn("src/a.ts", 2, "Minor"), severity: "low" }),
        bugOn("src/a.ts", 3, "Sure"),
      ),
    ]);
    expect(result.findings.map((f) => f.title)).toEqual(["Sure"]);
    expect(result.suppressedCounts.below_threshold).toBe(2);
  });

  it("accepts a repaired response and completes normally", async () => {
    const { result, provider } = await review([
      { findings: [modelFinding({ severity: "urgent" })], observations: [] },
      answer(bugOn("src/a.ts", 2)),
    ]);
    expect(provider.calls).toHaveLength(2);
    expect(result.status).toBe("completed");
    expect(result.findings).toHaveLength(1);
    expect(result.agentRuns[0]).toMatchObject({ agent: "code_review", status: "ok", retries: 1 });
    expect(result.warnings).toEqual([]);
  });

  it("aggregates agent runs, usage, warnings from the context and the governor snapshot", async () => {
    const context = await buildContext([file("src/a.ts")], {
      setup: { configFile: "provider: openai\nreview:\n  mode: warn\n" }, // a sensitive key: dropped with a warning
    });
    expect(context.warnings.length).toBeGreaterThan(0);
    const provider = createMockProvider({
      replies: [answer(bugOn("src/a.ts", 2))],
      usage: { inputTokens: 1000, outputTokens: 100 },
    });
    const result = await runReview(context, config, provider);
    expect(result.warnings).toEqual(expect.arrayContaining(context.warnings));
    expect(result.usage).toEqual({ inputTokens: 1000, outputTokens: 100 });
    expect(result.governor).toMatchObject({
      requests: 1,
      usage: { inputTokens: 1000, outputTokens: 100 },
    });
    expect(result.agentRuns).toEqual([
      expect.objectContaining({
        agent: "code_review",
        status: "ok",
        usage: { inputTokens: 1000, outputTokens: 100 },
        retries: 0,
        warnings: [],
      }),
    ]);
    expect(result.agentRuns[0]?.startedAt).toMatch(/^\d{4}-\d\d-\d\dT/);
    expect(result.suppressedCounts).toEqual({
      below_threshold: 0,
      invalid_line: 0,
      no_evidence: 0,
      duplicate: 0,
      style_only: 0,
      rejected_by_final_review: 0,
    });
  });

  it("keeps a finding that earlier comments already say: it is still a finding of this run (FR-37)", async () => {
    const first = await review([answer(bugOn("src/a.ts", 2))]);
    const posted = first.result.findings[0]!.id;
    const context = await buildContext([file("src/a.ts")], {
      setup: {
        reviewComments: [
          { id: 5, body: `x\n<!-- ai-pr-review:fp=${posted};sha=${"c".repeat(40)} -->` },
        ],
      },
    });
    const result = await runReview(
      context,
      config,
      createMockProvider({ replies: [answer(bugOn("src/a.ts", 2))] }),
    );
    // Not suppressed: the publisher does not post it again, and the summary lists it as still applicable.
    expect(result.findings.map((f) => f.id)).toEqual([posted]);
    expect(result.suppressedCounts.duplicate).toBe(0);
  });
});

describe("runReview: failure isolation (AC-8)", () => {
  const files = [file("src/a.ts")];
  // The fake agents here stand in for two of the real ones, so both must be enabled.
  const both = makeConfig({ agents: { test_coverage: false } });

  it("keeps the other agents' results when one agent throws, and reports partial", async () => {
    const context = await buildContext(files);
    const { logger, lines } = capturingLogger();
    const result = await runReview(context, both, createMockProvider(), undefined, {
      logger,
      agents: [
        fakeAgent("code_review", async () => okResult("code_review")),
        fakeAgent("security", async () => {
          throw new Error("SECRET_CANARY_in_error_message");
        }),
      ],
    });
    expect(result.status).toBe("partial");
    expect(result.agentRuns.map((r) => [r.agent, r.status])).toEqual([
      ["code_review", "ok"],
      ["security", "failed"],
    ]);
    expect(result.warnings).toContain("security: the review failed unexpectedly.");
    // Only the error's name reaches the log, never its message.
    expect(lines.join("\n")).not.toContain("SECRET_CANARY");
  });

  it("keeps findings of the healthy agent when the other one times out", async () => {
    const context = await buildContext(files);
    const healthy = fakeAgent("code_review", async (task) => {
      const finding = (
        await runReview(
          context,
          config,
          createMockProvider({ replies: [answer(bugOn("src/a.ts", 2))] }),
          task.signal,
        )
      ).findings;
      return okResult("code_review", { findings: finding });
    });
    let sawAbort = false;
    const hung = fakeAgent(
      "security",
      (task) =>
        new Promise<AgentResult>(() => {
          task.signal?.addEventListener("abort", () => (sawAbort = true));
        }),
    );
    const result = await runReview(context, both, createMockProvider(), undefined, {
      agents: [healthy, hung],
      agentTimeoutMs: 40,
    });
    expect(result.status).toBe("partial");
    expect(result.findings).toHaveLength(1);
    expect(result.agentRuns.find((r) => r.agent === "security")?.status).toBe("timeout");
    expect(result.warnings).toContain("security: did not finish in time and was stopped.");
    expect(sawAbort).toBe(true); // the agent was told to stop
  });

  it("maps a ProviderTimeout thrown by an agent to timeout", async () => {
    const context = await buildContext(files);
    const result = await runReview(context, both, createMockProvider(), undefined, {
      agents: [
        fakeAgent("code_review", async () => {
          throw new ProviderTimeout("x", "deepseek");
        }),
        fakeAgent("security", async () => okResult("security")),
      ],
    });
    expect(result.agentRuns[0]?.status).toBe("timeout");
    expect(result.status).toBe("partial");
  });

  it("reports failed when every agent fails and nothing was found", async () => {
    const context = await buildContext(files);
    const result = await runReview(context, both, createMockProvider(), undefined, {
      agents: [
        fakeAgent("code_review", async () => {
          throw new Error("a");
        }),
        fakeAgent("security", async () =>
          okResult("security", { status: "failed", warnings: ["security: down."] }),
        ),
      ],
    });
    expect(result.status).toBe("failed");
    expect(result.reason).toBeDefined();
    expect(result.findings).toEqual([]);
  });

  it("reports partial, not failed, when a failed agent still produced findings", async () => {
    const context = await buildContext(files);
    const finding = (
      await runReview(
        context,
        config,
        createMockProvider({ replies: [answer(bugOn("src/a.ts", 2))] }),
      )
    ).findings;
    const result = await runReview(context, both, createMockProvider(), undefined, {
      agents: [
        fakeAgent("code_review", async () =>
          okResult("code_review", { status: "failed", findings: finding }),
        ),
      ],
    });
    expect(result.status).toBe("partial");
    expect(result.findings).toHaveLength(1);
  });

  it("a real provider outage fails the Code Review agent but does not throw", async () => {
    const context = await buildContext(files);
    const result = await runReview(
      context,
      config,
      createMockProvider({ replies: [new ProviderTimeout("x", "deepseek")] }),
    );
    expect(result.status).toBe("failed");
    expect(result.agentRuns[0]?.status).toBe("timeout");
  });
});

describe("runReview: selecting and assigning agents", () => {
  it("runs only enabled agents and hands each its own files", async () => {
    const context = await buildContext([file("src/a.ts"), file("src/b.ts")]);
    const seen: Record<string, string[]> = {};
    const record =
      (id: AgentId): Agent["run"] =>
      async (task) => {
        seen[id] = task.files.map((f) => f.path);
        expect(task.config).toBe(config);
        expect(task.context).toBe(context);
        return okResult(id);
      };
    await runReview(
      context,
      makeConfig({ agents: { test_coverage: false } }),
      createMockProvider(),
      undefined,
      {
        agents: [
          fakeAgent("code_review", record("code_review"), {
            selectFiles: (c) => c.files.slice(0, 1),
          }),
          fakeAgent("test_coverage", record("test_coverage")),
          fakeAgent("security", record("security")),
        ],
      },
    );
    expect(seen).toEqual({ code_review: ["src/a.ts"], security: ["src/a.ts", "src/b.ts"] });
  });

  it("ignores enabled agents that are not implemented yet, without a warning", async () => {
    // Final Review (Phase 13) is not built; enabling it must not break the run.
    const context = await buildContext([file("src/a.ts")]);
    const result = await runReview(
      context,
      makeConfig({ agents: { test_coverage: false, security: false, final_review: true } }),
      createMockProvider({ replies: [answer()] }),
    );
    expect(result.agentRuns.map((r) => r.agent)).toEqual(["code_review"]);
    expect(result.warnings).toEqual([]);
  });

  it("skips the run when no agent is enabled", async () => {
    const context = await buildContext([file("src/a.ts")]);
    const provider = createMockProvider();
    const result = await runReview(
      context,
      makeConfig({ agents: { code_review: false, test_coverage: false, security: false } }),
      provider,
    );
    expect(result.status).toBe("skipped");
    expect(result.reason).toBe("No review agent is enabled.");
    expect(provider.calls).toHaveLength(0);
  });

  it("skips the run when nothing is left to review after filtering", async () => {
    const context = await buildContext([
      file("src/gone.ts", patch("@@ -1,1 +0,0 @@", "-x"), { status: "removed" }),
    ]);
    const provider = createMockProvider();
    const result = await runReview(context, config, provider);
    expect(result.status).toBe("skipped");
    expect(result.reason).toBe("No file is left to review after filtering.");
    expect(provider.calls).toHaveLength(0);
  });

  it("skips without calling a model when the size policy skipped the PR", async () => {
    const context = await buildContext(manyFiles(250), {
      pull: {},
      config: { ...RAW, review: { max_changed_files: 10 } },
    });
    expect(context.limits.status).toBe("skipped");
    const provider = createMockProvider();
    const result = await runReview(context, context.config, provider);
    expect(result.status).toBe("skipped");
    expect(result.reason).toBe(context.limits.reason);
    expect(provider.calls).toHaveLength(0);
  });

  it("reports partial with the reason when the size policy left files out", async () => {
    const context = await buildContext(manyFiles(14), {
      config: { ...RAW, review: { max_changed_files: 10 } },
    });
    expect(context.limits.status).toBe("limited");
    const result = await runReview(
      context,
      context.config,
      createMockProvider({ replies: [answer()] }),
    );
    expect(result.status).toBe("partial");
    expect(result.reason).toBe(context.limits.reason);
    expect(result.warnings).toContain(context.limits.reason);
  });
});

describe("runReview: cancellation (design §7)", () => {
  it("throws before doing anything when the signal is already aborted", async () => {
    const context = await buildContext([file("src/a.ts")]);
    const provider = createMockProvider();
    const controller = new AbortController();
    controller.abort();
    await expect(runReview(context, config, provider, controller.signal)).rejects.toBeInstanceOf(
      ReviewAborted,
    );
    expect(provider.calls).toHaveLength(0);
  });

  it("stops a run in flight and returns no result", async () => {
    const context = await buildContext([file("src/a.ts")]);
    const controller = new AbortController();
    const provider = createMockProvider({
      replies: [
        (req) =>
          new Promise((_resolve, reject) => {
            req.signal?.addEventListener("abort", () => reject(new Error("aborted")));
            setTimeout(() => controller.abort(), 5);
          }),
      ],
    });
    await expect(runReview(context, config, provider, controller.signal)).rejects.toBeInstanceOf(
      ReviewAborted,
    );
  });

  it("forwards the run's signal to the provider request", async () => {
    const context = await buildContext([file("src/a.ts")]);
    const controller = new AbortController();
    let seen: boolean | undefined;
    const provider = createMockProvider({
      replies: [
        (req) => {
          expect(req.signal?.aborted).toBe(false);
          controller.abort();
          seen = req.signal?.aborted;
          return answer();
        },
      ],
    });
    await expect(runReview(context, config, provider, controller.signal)).rejects.toBeInstanceOf(
      ReviewAborted,
    );
    expect(seen).toBe(true);
  });
});

describe("runReview: provider limits (FR-16)", () => {
  it("runs agents in parallel but never more requests at once than the cap", async () => {
    const context = await buildContext([file("src/a.ts")]);
    let active = 0;
    let peak = 0;
    const provider = createMockProvider({
      replies: [
        async () => {
          active += 1;
          peak = Math.max(peak, active);
          await new Promise((r) => setTimeout(r, 15));
          active -= 1;
          return answer();
        },
      ],
    });
    const caller = (id: AgentId): Agent =>
      fakeAgent(id, async (task, deps) => {
        for (let i = 0; i < 2; i += 1) {
          await deps.provider.complete({
            system: "s",
            user: "u",
            jsonSchema: {},
            maxOutputTokens: 10,
            timeoutMs: 1000,
            ...(task.signal ? { signal: task.signal } : {}),
          });
        }
        return okResult(id);
      });

    await runReview(context, makeConfig({ limits: { concurrency: 1 } }), provider, undefined, {
      agents: [caller("code_review"), caller("security"), caller("test_coverage")],
    });
    expect(provider.calls).toHaveLength(6);
    expect(peak).toBe(1);

    peak = 0;
    await runReview(context, makeConfig({ limits: { concurrency: 3 } }), provider, undefined, {
      agents: [caller("code_review"), caller("security"), caller("test_coverage")],
    });
    expect(peak).toBe(3); // the three agents did run in parallel
  });

  it("turns an exhausted request budget into a partial result", async () => {
    const small = createLlmAgent({
      id: "code_review",
      label: "Code Review",
      prompt: CODE_REVIEW_PROMPT,
      categories: ["bug", "performance", "maintainability"],
      maxInputTokens: 2_300,
    });
    const big = Array.from({ length: 8 }, (_, i) =>
      file(
        `src/p${i}.ts`,
        patch(
          "@@ -0,0 +1,6 @@",
          ...Array.from({ length: 6 }, (_, n) => `+const v${i}_${n} = "${"z".repeat(80)}";`),
        ),
      ),
    );
    const context = await buildContext(big);
    const provider = createMockProvider({ replies: [answer(bugOn("src/p0.ts", 1))] });
    const limited = makeConfig({ limits: { max_requests: 1 } });
    const governor = new RunGovernor(governorLimits(limited.limits));
    const result = await runReview(context, limited, provider, undefined, {
      agents: [small],
      governor,
    });
    expect(provider.calls).toHaveLength(1);
    expect(result.status).toBe("partial");
    expect(result.findings).toHaveLength(1);
    expect(result.warnings.join(" ")).toContain("budget");
    expect(result.governor.requests).toBe(1);
    expect(governor.snapshot().refused).toBeGreaterThan(0);
  });
});

describe("runReview: logging", () => {
  it("logs counts and timings but no code, PR text or finding text", async () => {
    const fixture = REVIEW_FIXTURES.find((f) => f.name === "prompt-injection")!;
    const context = await fixtureContext(fixture);
    const { logger, lines } = capturingLogger();
    await runReview(context, config, createMockProvider({ replies: [fixture.reply] }), undefined, {
      logger,
    });
    const log = lines.join("\n");
    expect(log).toContain("Review finished");
    expect(log).toContain("Agent finished");
    expect(log).toContain("prompt=code_review.v1");
    for (const secret of [
      "Date.now() < expiresAt",
      "pre-approved",
      "isExpired",
      "ignore all previous",
    ]) {
      expect(log).not.toContain(secret);
    }
  });
});

describe("the default engine", () => {
  it("has the Code Review and Test Coverage agents registered", async () => {
    const { DEFAULT_AGENTS } = await import("./orchestrator");
    expect(DEFAULT_AGENTS).toContain(codeReviewAgent);
    expect(DEFAULT_AGENTS.map((agent) => agent.id)).toContain("test_coverage");
  });
});

describe("no ambient data", () => {
  it("the engine modules never read the environment, the filesystem or a subprocess", () => {
    const src = join(__dirname, "..");
    const dirs = ["agents", "agents/codeReview", "validation", "prompts"];
    let count = 0;
    for (const dir of dirs) {
      const names = readdirSync(join(src, dir)).filter(
        (n) =>
          n.endsWith(".ts") &&
          !n.includes(".test.") &&
          n !== "test-support.ts" &&
          n !== "fixtures.ts",
      );
      for (const name of names) {
        count += 1;
        const text = readFileSync(join(src, dir, name), "utf8");
        expect(text, `${dir}/${name}`).not.toMatch(
          /process\.env|import\.meta\.env|node:fs|node:child_process|\bfetch\(/,
        );
      }
    }
    expect(count).toBeGreaterThan(10);
  });
});
