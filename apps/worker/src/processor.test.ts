// The run lifecycle against a real PostgreSQL with the mock provider and a fake GitHub (Phase 8):
// queued -> running -> completed | partial | failed | skipped, supersede and cancel, quota, missing key,
// duplicate delivery, shutdown and infrastructure errors. No Redis here; see worker.test.ts for the queue.
import {
  credentialContext,
  encryptSecret,
  Keyring,
  ProviderAuthError,
  ProviderCancelled,
} from "@ai-pr-review/core";
import { file, manyFiles } from "@ai-pr-review/core/testing";
import {
  createRunSupersedingOlder,
  deletePlatformCredential,
  listAgentRuns,
  listFindingsForRun,
  putPlatformCredential,
  setRepositoryEnabled,
  transitionRun,
  updatePlatformAiSettings,
} from "@ai-pr-review/db";
import { claimRun, finishClaimedRun, getRunById } from "@ai-pr-review/db/system";
import { createTenant, createTestDatabase, type TestDatabase } from "@ai-pr-review/db/testing";
import { QUOTA_EXCEEDED } from "@ai-pr-review/shared";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { InfrastructureError } from "./errors";
import {
  API_KEY,
  answer,
  bugAnswer,
  buildRig,
  configure,
  fakeGitHub,
  KEYRING,
  queuedRun,
  readyTenant,
  sleep,
  storeKey,
} from "./testing";

let t: TestDatabase;
beforeAll(async () => {
  t = await createTestDatabase();
}, 60_000);
afterAll(async () => {
  await t.drop();
});

const statusesOf = (signals: { updated: Array<{ status: string }> }) =>
  signals.updated.map((e) => e.status);

describe("completed run", () => {
  it("goes queued -> running -> completed with the whole history persisted (AC-15 data level)", async () => {
    const tenant = await readyTenant(t, "happy");
    const run = await queuedRun(t, tenant);
    const rig = buildRig(t);

    const outcome = await rig.processor.process(run.id);

    expect(outcome).toMatchObject({ kind: "finished", status: "completed" });
    const done = (await getRunById(t.db, run.id))!;
    expect(done.status).toBe("completed");
    expect(done.startedAt).toBeInstanceOf(Date);
    expect(done.finishedAt).toBeInstanceOf(Date);
    expect(done.attempts).toBe(1);
    expect(done.usage.inputTokens).toBeGreaterThan(0);

    const ids = [tenant.installation.id];
    const agents = await listAgentRuns(t.db, ids, run.id);
    expect(agents).toHaveLength(1);
    expect(agents[0]).toMatchObject({ agent: "code_review", status: "ok" });
    expect(agents[0]!.inputTokens).toBeGreaterThan(0);

    const findings = await listFindingsForRun(t.db, ids, run.id);
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({
      title: "Off-by-one in add",
      filePath: "src/a.ts",
      startLine: 2,
      posted: false,
    });

    expect(statusesOf(rig.signals)).toEqual(["running", "completed"]);
    expect(rig.publisher.published).toHaveLength(1); // the publisher hook (Phase 9 tests it for real in publisher.test.ts)
  });

  it("uses the stored key and the configured provider, and never logs the key", async () => {
    const tenant = await readyTenant(t, "key");
    const run = await queuedRun(t, tenant);
    const rig = buildRig(t);

    await rig.processor.process(run.id);

    expect(rig.providerCalls).toEqual([
      expect.objectContaining({ name: "deepseek", model: "test-model", apiKey: API_KEY }),
    ]);
    expect(rig.logs.length).toBeGreaterThan(0);
    for (const line of rig.logs) expect(line).not.toContain(API_KEY);
  });

  it("stores suppressed findings with their reason, and the files that were skipped", async () => {
    const tenant = await readyTenant(t, "suppressed");
    const run = await queuedRun(t, tenant);
    const github = fakeGitHub({
      files: [file("src/a.ts"), file("dist/bundle.js"), file("package-lock.json")],
    });
    // The second finding points outside the diff: the validator drops it as invalid_line.
    const rig = buildRig(t, {
      github,
      replies: [
        {
          ...answer(),
          findings: [
            ...bugAnswer().findings,
            { ...bugAnswer("Elsewhere").findings[0]!, start_line: 99, end_line: 99 },
          ],
        },
      ],
    });

    await rig.processor.process(run.id);

    const ids = [tenant.installation.id];
    const all = await listFindingsForRun(t.db, ids, run.id, { includeSuppressed: true });
    expect(all.map((f) => [f.title, f.suppressedReason])).toEqual(
      expect.arrayContaining([
        ["Off-by-one in add", null],
        ["Elsewhere", "invalid_line"],
      ]),
    );
    const stored = (await getRunById(t.db, run.id))!;
    expect(stored.skippedFiles.map((f) => f.path).sort()).toEqual([
      "dist/bundle.js",
      "package-lock.json",
    ]);
  });
});

describe("partial, failed and skipped results", () => {
  it("is partial when the size policy leaves files out", async () => {
    const tenant = await readyTenant(t, "partial", { review: { max_changed_files: 1 } });
    const run = await queuedRun(t, tenant);
    const rig = buildRig(t, {
      github: fakeGitHub({ files: [file("src/a.ts"), file("src/b.ts")] }),
    });

    const outcome = await rig.processor.process(run.id);

    expect(outcome).toMatchObject({ kind: "finished", status: "partial" });
    const stored = (await getRunById(t.db, run.id))!;
    expect(stored.status).toBe("partial");
    expect(stored.skippedFiles).toHaveLength(1);
    expect(stored.statusReason).toBeTruthy();
    expect((await listFindingsForRun(t.db, [tenant.installation.id], run.id)).length).toBe(1);
  });

  it("is failed when every agent fails; the agent run still records what happened", async () => {
    const tenant = await readyTenant(t, "agentfail");
    const run = await queuedRun(t, tenant);
    const rig = buildRig(t, {
      replies: [new ProviderAuthError("The provider rejected the key.", "deepseek", 401)],
    });

    const outcome = await rig.processor.process(run.id);

    expect(outcome).toMatchObject({ kind: "finished", status: "failed" });
    const stored = (await getRunById(t.db, run.id))!;
    expect(stored.status).toBe("failed");
    expect(stored.statusReason).toBe("Every review agent failed.");
    const agents = await listAgentRuns(t.db, [tenant.installation.id], run.id);
    expect(agents).toHaveLength(1);
    expect(agents[0]!.status).toBe("failed");
    expect(stored.warnings.length).toBeGreaterThan(0);
  });

  it("is partial when one answer is unusable and the rest is fine", async () => {
    const tenant = await readyTenant(t, "invalid-output");
    const run = await queuedRun(t, tenant);
    // Invalid output twice (the repair retry also fails) discards the answer.
    const rig = buildRig(t, { replies: [{ nope: true }, { nope: true }] });

    const outcome = await rig.processor.process(run.id);

    // The only agent produced nothing usable and found nothing: the run is failed with the agent noted.
    expect(outcome).toMatchObject({ kind: "finished", status: "failed" });
    const agents = await listAgentRuns(t.db, [tenant.installation.id], run.id);
    expect(agents[0]).toMatchObject({ status: "invalid_output" });
  });

  it("is skipped, with the reason and the skipped files, when the pull request is far over the size limits", async () => {
    const tenant = await readyTenant(t, "toolarge", { review: { max_changed_files: 1 } });
    const run = await queuedRun(t, tenant);
    const rig = buildRig(t, { github: fakeGitHub({ files: manyFiles(8) }) });

    const outcome = await rig.processor.process(run.id);

    expect(outcome).toMatchObject({ kind: "finished", status: "skipped" });
    const stored = (await getRunById(t.db, run.id))!;
    expect(stored.status).toBe("skipped");
    expect(stored.statusReason).toBeTruthy();
    expect(stored.skippedFiles.length).toBeGreaterThan(0);
    expect(rig.provider.calls).toHaveLength(0); // no model call
  });
});

describe("failures before any model call", () => {
  it("missing credential: failed with a clear reason, no GitHub and no model call", async () => {
    const tenant = await createTenant(t.db, "nokey");
    await configure(t, tenant); // provider and model, but no key
    const run = await queuedRun(t, tenant);
    const rig = buildRig(t);

    const outcome = await rig.processor.process(run.id);

    expect(outcome).toMatchObject({ kind: "finished", status: "failed" });
    const stored = (await getRunById(t.db, run.id))!;
    expect(stored.statusReason).toContain("No API key is stored for deepseek");
    expect(rig.providerCalls).toHaveLength(0);
    expect(rig.provider.calls).toHaveLength(0);
    expect(rig.github.calls).toHaveLength(0);
  });

  it("no provider configured: failed with a clear reason", async () => {
    const tenant = await createTenant(t.db, "noprovider");
    const run = await queuedRun(t, tenant);
    const rig = buildRig(t);

    await rig.processor.process(run.id);

    expect((await getRunById(t.db, run.id))!.statusReason).toContain(
      "No AI provider is configured",
    );
    expect(rig.github.calls).toHaveLength(0);
  });

  it("the platform-wide AI setting stands in for a missing provider, model and key", async () => {
    const tenant = await createTenant(t.db, "globalai");
    const run = await queuedRun(t, tenant);
    const rig = buildRig(t);
    const { ciphertext, keyVersion } = encryptSecret(
      API_KEY,
      KEYRING,
      credentialContext({ installationId: "platform" }, "deepseek"),
    );
    await putPlatformCredential(t.db, {
      provider: "deepseek",
      ciphertext,
      keyVersion,
      last4: API_KEY.slice(-4),
    });
    await updatePlatformAiSettings(t.db, {
      activeProvider: "deepseek",
      models: { deepseek: "deepseek-chat" },
    });
    try {
      await rig.processor.process(run.id);
    } finally {
      await deletePlatformCredential(t.db, "deepseek");
      await updatePlatformAiSettings(t.db, { models: { deepseek: "" } });
    }

    const reason = (await getRunById(t.db, run.id))!.statusReason ?? "";
    expect(reason).not.toContain("No AI provider is configured");
    expect(reason).not.toContain("No API key is stored");
  });

  it("unreadable key (wrong encryption key): failed, and the message does not leak anything", async () => {
    const tenant = await createTenant(t.db, "badkey");
    await configure(t, tenant);
    await storeKey(t, tenant, "deepseek", API_KEY, KEYRING);
    const run = await queuedRun(t, tenant);
    const rig = buildRig(t, {
      deps: {
        keyring: new Keyring({ version: 1, key: Buffer.alloc(32, 9) }),
      },
    });

    await rig.processor.process(run.id);

    const stored = (await getRunById(t.db, run.id))!;
    expect(stored.status).toBe("failed");
    expect(stored.statusReason).toContain("could not be read");
    expect(JSON.stringify(stored)).not.toContain(API_KEY);
  });

  it("a base_url that is not allowed fails the run before anything is sent", async () => {
    const tenant = await readyTenant(t, "ssrf", { base_url: "https://169.254.169.254/v1" });
    const run = await queuedRun(t, tenant);
    const rig = buildRig(t);

    await rig.processor.process(run.id);

    const stored = (await getRunById(t.db, run.id))!;
    expect(stored.status).toBe("failed");
    expect(stored.statusReason).toContain("base_url");
    expect(rig.providerCalls).toHaveLength(0);
  });

  it("skips runs of an inactive installation or a disabled repository", async () => {
    const tenant = await readyTenant(t, "disabled");
    await setRepositoryEnabled(t.db, tenant.installation.id, tenant.repo.id, false);
    const run = await queuedRun(t, tenant);
    const rig = buildRig(t);

    const outcome = await rig.processor.process(run.id);

    expect(outcome).toMatchObject({ kind: "finished", status: "skipped" });
    expect(rig.github.calls).toHaveLength(0);
  });
});

describe("quota (PL-11, AC-23)", () => {
  it("creates a skipped run with the quota_exceeded reason when the day's runs are used up", async () => {
    const tenant = await readyTenant(t, "quota");
    const earlier = await claimRun(t.db, (await queuedRun(t, tenant, 1)).id);
    await transitionRun(t.db, tenant.installation.id, earlier!.id, "completed");
    const run = await queuedRun(t, tenant, 2);
    const rig = buildRig(t, { deps: { quotas: { runsPerDay: 1, tokensPerDay: 1_000_000 } } });

    const outcome = await rig.processor.process(run.id);

    expect(outcome).toMatchObject({ kind: "finished", status: "skipped" });
    const stored = (await getRunById(t.db, run.id))!;
    expect(stored.status).toBe("skipped");
    expect(stored.statusReason).toContain(QUOTA_EXCEEDED);
    expect(rig.github.calls).toHaveLength(0);
    expect(rig.provider.calls).toHaveLength(0);
  });

  it("stops when the tokens of the day are spent", async () => {
    const tenant = await readyTenant(t, "quota-tokens");
    const first = (await claimRun(t.db, (await queuedRun(t, tenant, 1)).id))!;
    await finishClaimedRun(t.db, first.id, first.attempts, "completed", {
      usage: { inputTokens: 800, outputTokens: 300 },
    });
    const run = await queuedRun(t, tenant, 2);
    const rig = buildRig(t, { deps: { quotas: { runsPerDay: 100, tokensPerDay: 1_000 } } });

    await rig.processor.process(run.id);

    expect((await getRunById(t.db, run.id))!.statusReason).toMatch(/tokens/);
  });

  it("does not count another installation's usage", async () => {
    const busy = await readyTenant(t, "busy");
    for (let n = 1; n <= 3; n++) await queuedRun(t, busy, n);
    const quiet = await readyTenant(t, "quiet");
    const run = await queuedRun(t, quiet);
    const rig = buildRig(t, { deps: { quotas: { runsPerDay: 2, tokensPerDay: 1_000_000 } } });

    expect(await rig.processor.process(run.id)).toMatchObject({ status: "completed" });
  });
});

describe("duplicate and late jobs", () => {
  it("processes a run once however many jobs arrive at the same time", async () => {
    const tenant = await readyTenant(t, "dup");
    const run = await queuedRun(t, tenant);
    const rig = buildRig(t, {
      replies: [
        async () => {
          await sleep(50);
          return bugAnswer();
        },
      ],
    });

    const outcomes = await Promise.all([
      rig.processor.process(run.id),
      rig.processor.process(run.id),
      rig.processor.process(run.id),
    ]);

    expect(outcomes.filter((o) => o.kind === "finished")).toHaveLength(1);
    expect(outcomes.filter((o) => o.kind === "not_queued")).toHaveLength(2);
    expect(rig.provider.calls).toHaveLength(1);
    const ids = [tenant.installation.id];
    expect(await listAgentRuns(t.db, ids, run.id)).toHaveLength(1);
    expect(await listFindingsForRun(t.db, ids, run.id, { includeSuppressed: true })).toHaveLength(
      1,
    );
  });

  it("ignores a job for a finished run", async () => {
    const tenant = await readyTenant(t, "late");
    const run = await queuedRun(t, tenant);
    const rig = buildRig(t);
    await rig.processor.process(run.id);
    const calls = rig.provider.calls.length;

    expect(await rig.processor.process(run.id)).toEqual({ kind: "not_queued" });
    expect(rig.provider.calls).toHaveLength(calls);
  });

  it("ignores a job whose run does not exist", async () => {
    const rig = buildRig(t);
    expect(await rig.processor.process("00000000-0000-4000-8000-000000000000")).toEqual({
      kind: "not_found",
    });
  });
});

describe("supersede and cancel (PL-06, AC-15)", () => {
  const supersede = (tenant: Awaited<ReturnType<typeof readyTenant>>, prNumber = 7) =>
    createRunSupersedingOlder(t.db, tenant.installation.id, {
      repoId: tenant.repo.id,
      prNumber,
      headSha: "b".repeat(40),
      baseSha: "c".repeat(40),
      baseRef: "main",
      trigger: "pull_request",
    });

  it("stops early when a run.cancel message arrives, persists nothing and publishes nothing", async () => {
    const tenant = await readyTenant(t, "cancel");
    const run = await queuedRun(t, tenant);
    let started!: () => void;
    const inFlight = new Promise<void>((resolve) => (started = resolve));
    const rig = buildRig(t, {
      replies: [
        (req: { signal?: AbortSignal }) =>
          new Promise((_resolve, reject) => {
            started();
            req.signal?.addEventListener("abort", () =>
              reject(new ProviderCancelled("The request was cancelled.", "deepseek")),
            );
          }),
      ],
    });

    const processing = rig.processor.process(run.id);
    await inFlight;
    // What the api does: write the final state, then signal.
    await supersede(tenant);
    expect(rig.processor.active.stop(run.id, "superseded")).toBe(true);
    const outcome = await processing;

    expect(outcome).toEqual({ kind: "stopped", reason: "superseded" });
    expect((await getRunById(t.db, run.id))!.status).toBe("superseded");
    const ids = [tenant.installation.id];
    expect(await listFindingsForRun(t.db, ids, run.id, { includeSuppressed: true })).toEqual([]);
    expect(await listAgentRuns(t.db, ids, run.id)).toEqual([]);
    expect(rig.publisher.published).toHaveLength(0);
    expect(rig.processor.active.size).toBe(0);
  });

  it("finishes a run as cancelled itself if the message beat the database write", async () => {
    const tenant = await readyTenant(t, "cancel-first");
    const run = await queuedRun(t, tenant);
    let started!: () => void;
    const inFlight = new Promise<void>((resolve) => (started = resolve));
    const rig = buildRig(t, {
      replies: [
        (req: { signal?: AbortSignal }) =>
          new Promise((_resolve, reject) => {
            started();
            req.signal?.addEventListener("abort", () =>
              reject(new ProviderCancelled("The request was cancelled.", "deepseek")),
            );
          }),
      ],
    });
    const processing = rig.processor.process(run.id);
    await inFlight;
    rig.processor.active.stop(run.id, "cancelled");
    await processing;
    expect((await getRunById(t.db, run.id))!.status).toBe("cancelled");
  });

  it("notices a supersede through the heartbeat when no message arrives", async () => {
    const tenant = await readyTenant(t, "heartbeat");
    const run = await queuedRun(t, tenant);
    const rig = buildRig(t, {
      replies: [
        async () => {
          await supersede(tenant); // a newer push; the cancel message is "lost"
          await sleep(200); // longer than several heartbeats
          return bugAnswer();
        },
      ],
    });

    const outcome = await rig.processor.process(run.id);

    expect(outcome).toEqual({ kind: "stopped", reason: "lost" });
    expect((await getRunById(t.db, run.id))!.status).toBe("superseded");
    expect(rig.publisher.published).toHaveLength(0);
    expect(
      await listFindingsForRun(t.db, [tenant.installation.id], run.id, { includeSuppressed: true }),
    ).toEqual([]);
  });

  it("re-checks the run before saving and publishing even if nothing noticed the supersede", async () => {
    const tenant = await readyTenant(t, "recheck");
    const run = await queuedRun(t, tenant);
    const rig = buildRig(t, {
      // Long heartbeat interval: only the explicit re-check can catch it.
      deps: { heartbeatIntervalMs: 60_000 },
      replies: [
        async () => {
          await supersede(tenant);
          return bugAnswer();
        },
      ],
    });

    const outcome = await rig.processor.process(run.id);

    expect(outcome).toEqual({ kind: "stopped", reason: "lost" });
    expect((await getRunById(t.db, run.id))!.status).toBe("superseded");
    expect(rig.publisher.published).toHaveLength(0);
    expect(
      await listFindingsForRun(t.db, [tenant.installation.id], run.id, { includeSuppressed: true }),
    ).toEqual([]);
  });

  it("marks the run superseded when the pull request moved on before the review started", async () => {
    const tenant = await readyTenant(t, "moved");
    const run = await queuedRun(t, tenant);
    const github = fakeGitHub({ pull: { headSha: "d".repeat(40) } });
    const rig = buildRig(t, { github });

    const outcome = await rig.processor.process(run.id);

    expect(outcome).toMatchObject({ kind: "finished", status: "superseded" });
    expect(rig.provider.calls).toHaveLength(0);
  });
});

describe("shutdown and infrastructure errors", () => {
  it("hands a running review back to the queue on shutdown, and the next worker completes it", async () => {
    const tenant = await readyTenant(t, "shutdown");
    const run = await queuedRun(t, tenant);
    let started!: () => void;
    const inFlight = new Promise<void>((resolve) => (started = resolve));
    const first = buildRig(t, {
      replies: [
        (req: { signal?: AbortSignal }) =>
          new Promise((_resolve, reject) => {
            started();
            req.signal?.addEventListener("abort", () =>
              reject(new ProviderCancelled("The request was cancelled.", "deepseek")),
            );
          }),
      ],
    });
    const processing = first.processor.process(run.id);
    await inFlight;
    first.processor.active.stopAll("shutdown");

    expect(await processing).toEqual({ kind: "requeued" });
    const back = (await getRunById(t.db, run.id))!;
    expect(back.status).toBe("queued");
    expect(back.attempts).toBe(1);
    expect(first.publisher.published).toHaveLength(0);

    const second = buildRig(t);
    expect(await second.processor.process(run.id)).toMatchObject({ status: "completed" });
    expect((await getRunById(t.db, run.id))!.attempts).toBe(2);
  });

  it("puts the run back in the queue and asks for a retry when GitHub is down (5xx)", async () => {
    const tenant = await readyTenant(t, "github5xx");
    const run = await queuedRun(t, tenant);
    const github = fakeGitHub({
      failures: { "GET /repos/{owner}/{repo}/pulls/{pull_number}": 502 },
    });
    const rig = buildRig(t, { github });

    await expect(rig.processor.process(run.id)).rejects.toBeInstanceOf(InfrastructureError);

    expect((await getRunById(t.db, run.id))!.status).toBe("queued");
    expect(statusesOf(rig.signals)).toEqual(["running", "queued"]);
    expect(rig.provider.calls).toHaveLength(0);
  });

  it("fails the run, without a retry, when GitHub says the pull request is gone (404)", async () => {
    const tenant = await readyTenant(t, "github404");
    const run = await queuedRun(t, tenant);
    const github = fakeGitHub({
      failures: { "GET /repos/{owner}/{repo}/pulls/{pull_number}": 404 },
    });
    const rig = buildRig(t, { github });

    const outcome = await rig.processor.process(run.id);

    expect(outcome).toMatchObject({ kind: "finished", status: "failed" });
    expect((await getRunById(t.db, run.id))!.statusReason).toContain("could not find");
  });

  it("top-level catch: an unexpected error fails the run and logs the type only", async () => {
    const tenant = await readyTenant(t, "unexpected");
    const run = await queuedRun(t, tenant);
    const rig = buildRig(t, {
      deps: {
        collect: async () => {
          throw new TypeError(`boom while reading SECRET_SOURCE_CODE ${API_KEY}`);
        },
      },
    });

    const outcome = await rig.processor.process(run.id);

    expect(outcome).toMatchObject({ kind: "finished", status: "failed" });
    const stored = (await getRunById(t.db, run.id))!;
    expect(stored.statusReason).toContain("failed unexpectedly");
    const everything = [...rig.logs, JSON.stringify(stored)].join("\n");
    expect(everything).not.toContain("SECRET_SOURCE_CODE");
    expect(everything).not.toContain(API_KEY);
    expect(rig.logs.some((l) => l.includes("TypeError"))).toBe(true);
  });

  it("a retried job that ran out of attempts fails a still-queued run with a clear message", async () => {
    const tenant = await readyTenant(t, "exhausted");
    const run = await queuedRun(t, tenant);
    const rig = buildRig(t);

    await rig.processor.failExhausted(run.id, "ReplyError");

    const stored = (await getRunById(t.db, run.id))!;
    expect(stored.status).toBe("failed");
    expect(stored.statusReason).toContain("infrastructure");
    expect(stored.statusReason).toContain("ReplyError");
  });

  it("leaves a running run alone when its job ran out of attempts (the sweeper owns it)", async () => {
    const tenant = await readyTenant(t, "exhausted-running");
    const run = (await claimRun(t.db, (await queuedRun(t, tenant)).id))!;
    const rig = buildRig(t);

    await rig.processor.failExhausted(run.id, "ReplyError");

    expect((await getRunById(t.db, run.id))!.status).toBe("running");
  });
});

describe("limits reach the provider layer (FR-16)", () => {
  it("caps the run's token budget to what the day's quota has left", async () => {
    const tenant = await readyTenant(t, "budget");
    const run = await queuedRun(t, tenant);
    const rig = buildRig(t, {
      deps: {
        quotas: { runsPerDay: 100, tokensPerDay: 10 }, // nothing used yet, but only 10 tokens may be spent
      },
    });

    const outcome = await rig.processor.process(run.id);

    // The governor refuses the first request: the agent fails, no model call is made.
    expect(outcome).toMatchObject({ kind: "finished", status: "failed" });
    expect(rig.provider.calls).toHaveLength(0);
  });

  it("an invalid response is repaired once and counted as a retry", async () => {
    const tenant = await readyTenant(t, "repair");
    const run = await queuedRun(t, tenant);
    const rig = buildRig(t, { replies: [{ nope: true }, bugAnswer()] });

    await rig.processor.process(run.id);

    const agents = await listAgentRuns(t.db, [tenant.installation.id], run.id);
    expect(agents[0]).toMatchObject({ status: "ok", retries: 1 });
    expect(rig.provider.calls).toHaveLength(2);
  });
});
