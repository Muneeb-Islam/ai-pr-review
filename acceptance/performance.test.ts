// Phase 16 performance and cost checks that the software alone decides (docs/pilot.md has the ones that need a real
// provider and real repositories):
//
//   - a pull request at the configured size limits (40 files, 120,000 patch characters) is reviewed, not skipped,
//     within the request and token budgets, and one file over the limit is skipped without a model call;
//   - webhook accepted -> run `queued`, p95 < 3 s, and API reads p95 < 500 ms (scope §8).
//
// The numbers are in-process: no network, a mock provider, a local database. They prove the platform adds no
// avoidable delay; the 5-minute median of a real review is a pilot measurement. Set ACCEPTANCE_REPORT=1 to print them.
import {
  answer,
  createFakeGitHub,
  createFakePublisherGitHub,
  makeConfig,
  manyFiles,
} from "@ai-pr-review/core/testing";
import { createTestDatabase, type TestDatabase } from "@ai-pr-review/db/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createHarness, type Harness, type Session } from "../apps/api/src/testing/harness";
import { fixture, prEvent, sha } from "../apps/api/src/webhooks/testing";
import {
  APP_LOGIN,
  buildRig,
  HEAD_SHA,
  queuedRun,
  readyTenant,
  realPublisher,
} from "../apps/worker/src/testing";

const report = (line: string): void => {
  if (process.env["ACCEPTANCE_REPORT"]) process.stdout.write(`[acceptance] ${line}\n`);
};

export const percentile = (values: number[], p: number): number => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)]!;
};

// The defaults a repository gets without configuring anything.
const configured = makeConfig();
const DEFAULT_LIMITS = {
  maxChangedFiles: configured.review.max_changed_files,
  maxPatchCharacters: configured.review.max_patch_characters,
  maxRequests: configured.limits.max_requests,
};

const patchChars = (files: Array<{ patch?: string }>) =>
  files.reduce((sum, f) => sum + (f.patch?.length ?? 0), 0);

describe("a pull request at the configured limits", () => {
  let t: TestDatabase;
  beforeAll(async () => {
    t = await createTestDatabase();
  }, 60_000);
  afterAll(async () => {
    await t.drop();
  });

  async function review(files: ReturnType<typeof manyFiles>, label: string) {
    const tenant = await readyTenant(t, label);
    const run = await queuedRun(t, tenant, 1);
    const publisherGitHub = createFakePublisherGitHub({ headSha: HEAD_SHA, appLogin: APP_LOGIN });
    const fake = createFakeGitHub({ files, pull: { headSha: HEAD_SHA } });
    const rig = buildRig(t, {
      replies: [answer()],
      github: {
        calls: fake.calls,
        client: fake.client,
        access: { getClient: async () => fake.client },
      },
      deps: { publisher: realPublisher(t, publisherGitHub), appLogin: APP_LOGIN },
    });
    const started = performance.now();
    const outcome = await rig.processor.process(run.id);
    return { outcome, rig, ms: performance.now() - started, github: publisherGitHub };
  }

  it("is reviewed within the request and token budgets", async () => {
    // 40 files of about 3,000 patch characters each: as close to the 120,000-character limit as the files allow.
    const files = manyFiles(DEFAULT_LIMITS.maxChangedFiles, 2_950);
    expect(files).toHaveLength(DEFAULT_LIMITS.maxChangedFiles);
    expect(patchChars(files)).toBeLessThanOrEqual(DEFAULT_LIMITS.maxPatchCharacters);
    expect(patchChars(files)).toBeGreaterThan(DEFAULT_LIMITS.maxPatchCharacters * 0.9);

    const { outcome, rig, ms, github } = await review(files, "at-limit");
    expect(outcome).toMatchObject({ kind: "finished", status: "completed" });
    expect(github.state.checkRuns.length + github.state.issueComments.length).toBeGreaterThan(0);

    const calls = rig.provider.calls.length;
    expect(calls).toBeGreaterThan(0);
    expect(calls).toBeLessThanOrEqual(DEFAULT_LIMITS.maxRequests);
    // The platform's own work, with the model taking no time. A real review adds the model's latency (docs/pilot.md).
    expect(ms).toBeLessThan(30_000);
    report(
      `PR at limits: ${files.length} files, ${patchChars(files)} patch characters -> ${calls} model request(s), platform time ${Math.round(ms)} ms`,
    );
  });

  it("one file over the limit: the first 40 are reviewed, and the summary says what was left out (FR-09)", async () => {
    const files = manyFiles(DEFAULT_LIMITS.maxChangedFiles + 1, 200);
    const { outcome, rig, github } = await review(files, "one-over");
    expect(outcome).toMatchObject({ kind: "finished", status: "partial" });
    expect(rig.provider.calls.length).toBeGreaterThan(0);
    expect(github.state.issueComments[0]?.body).toContain("Reviewed 40 of 41 files");
  });

  it("far over the limit: skipped with the reason, no model is called, the check is neutral (FR-09)", async () => {
    const files = manyFiles(DEFAULT_LIMITS.maxChangedFiles * 8, 200);
    const { outcome, rig, github } = await review(files, "far-over");
    expect(outcome).toMatchObject({ kind: "finished", status: "skipped" });
    expect(rig.provider.calls).toHaveLength(0);
    expect(github.state.issueComments[0]?.body).toContain("too large to review reliably");
  });
});

describe("what a review sends, by size of the pull request (docs/costs.md)", () => {
  let t: TestDatabase;
  beforeAll(async () => {
    t = await createTestDatabase();
  }, 60_000);
  afterAll(async () => {
    await t.drop();
  });

  // The prompts are the real ones; the tokens are the platform's own estimate (about four characters a token), so
  // these are the size of the request, not a bill. Output is whatever the model chooses to write and is not measured.
  const CLASSES = [
    { name: "small", files: 3, chars: 1_500 },
    { name: "medium", files: 15, chars: 2_000 },
    { name: "at the limits", files: 40, chars: 2_950 },
  ];

  for (const c of CLASSES) {
    it(`${c.name}: ${c.files} files, all three agents, stays inside the request and token budgets`, async () => {
      const files = manyFiles(c.files, c.chars);
      const tenant = await readyTenant(t, `size-${c.name}`, {
        agents: { code_review: true, test_coverage: true, security: true },
      });
      const run = await queuedRun(t, tenant, 1);
      const publisherGitHub = createFakePublisherGitHub({ headSha: HEAD_SHA, appLogin: APP_LOGIN });
      const fake = createFakeGitHub({ files, pull: { headSha: HEAD_SHA } });
      const rig = buildRig(t, {
        replies: [answer()],
        github: {
          calls: fake.calls,
          client: fake.client,
          access: { getClient: async () => fake.client },
        },
        deps: { publisher: realPublisher(t, publisherGitHub), appLogin: APP_LOGIN },
      });
      const outcome = await rig.processor.process(run.id);
      expect(outcome.kind).toBe("finished");

      const requests = rig.provider.calls.length;
      const inputTokens = rig.provider.calls.reduce(
        (sum, call) => sum + Math.ceil((call.system.length + call.user.length) / 4),
        0,
      );
      expect(requests).toBeLessThanOrEqual(DEFAULT_LIMITS.maxRequests);
      expect(inputTokens).toBeLessThan(configured.limits.max_total_tokens);
      report(
        `size class ${c.name}: ${files.length} files, ${patchChars(files)} patch characters -> ${requests} request(s), about ${inputTokens} input tokens`,
      );
    });
  }
});

describe("the platform's own latency targets (scope §8)", () => {
  let h: Harness;
  let dana: Session;
  const N = 60;

  beforeAll(async () => {
    h = await createHarness({ webhooks: {} });
    await h.postWebhook("installation", fixture("installation.created"));
    await h.webhookService!.idle();
    h.github.users.set("dana", {
      id: 4242,
      login: "dana",
      installations: [
        {
          id: 1001,
          accountLogin: "acme",
          accountType: "organization",
          orgRole: "admin",
          repos: [{ id: 2001, fullName: "acme/widgets", admin: true }],
        },
      ],
    });
    dana = await h.signIn("dana");
  }, 60_000);
  afterAll(async () => {
    await h.close();
  });

  it("webhook accepted -> run queued: p95 under 3 seconds", async () => {
    const samples: number[] = [];
    for (let pr = 1; pr <= N; pr++) {
      h.gateway.snapshot = {
        pr: {
          number: pr,
          baseRef: "main",
          headSha: sha((pr % 9) + 1),
          isDraft: false,
          isFork: false,
        },
        baseSha: sha(2),
        state: "open",
      };
      const started = performance.now();
      const res = await h.postWebhook(
        "pull_request",
        prEvent("opened", { headSha: sha((pr % 9) + 1), number: pr }),
      );
      await h.webhookService!.idle();
      samples.push(performance.now() - started);
      expect(res.statusCode).toBe(202);
    }
    const { rows } = await h.t.pool.query<{ n: string }>(
      "select count(*) as n from review_runs where status = 'queued'",
    );
    expect(Number(rows[0]!.n)).toBe(N);
    const p95 = percentile(samples, 95);
    report(
      `webhook -> queued: p50 ${Math.round(percentile(samples, 50))} ms, p95 ${Math.round(p95)} ms (n=${N})`,
    );
    expect(p95).toBeLessThan(3_000);
  });

  it("API reads: p95 under 500 ms", async () => {
    const urls = [
      "/api/me",
      "/api/repos",
      "/api/runs",
      "/api/runs?status=queued",
      "/api/findings",
      "/api/analytics/summary",
    ];
    const first = (await h.request(dana, "GET", "/api/runs")).json().items[0].id as string;
    urls.push(`/api/runs/${first}`);
    const samples: number[] = [];
    for (let round = 0; round < 15; round++) {
      for (const url of urls) {
        const started = performance.now();
        const res = await h.request(dana, "GET", url);
        samples.push(performance.now() - started);
        expect(res.statusCode, url).toBe(200);
      }
    }
    const p95 = percentile(samples, 95);
    report(
      `API reads over ${N} runs: p50 ${Math.round(percentile(samples, 50))} ms, p95 ${Math.round(p95)} ms (n=${samples.length})`,
    );
    expect(p95).toBeLessThan(500);
  });
});
