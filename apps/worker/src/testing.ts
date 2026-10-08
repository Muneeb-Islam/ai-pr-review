// Test helpers for the worker: a tenant with a stored key and settings, a fake GitHub, a scripted provider and a
// processor wired to recording signals. Not for production code.
import { existsSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";
import {
  createMockProvider,
  credentialContext,
  encryptSecret,
  Keyring,
  type ContextClient,
  type MockProvider,
  type MockReply,
  type Provider,
} from "@ai-pr-review/core";
import {
  answer,
  createFakeGitHub,
  createFakePublisherGitHub,
  file,
  modelFinding,
  type FakeGitHubSetup,
  type FakePublisherGitHub,
  type FakePublisherSetup,
} from "@ai-pr-review/core/testing";
import {
  putProviderCredential,
  upsertInstallationSettings,
  upsertRepoSettings,
} from "@ai-pr-review/db";
import { createTenant, makeRun, type Tenant, type TestDatabase } from "@ai-pr-review/db/testing";
import { InMemoryRunSignals } from "@ai-pr-review/queue";
import type { Run } from "@ai-pr-review/db";
import { createLogger, type Logger, type ProviderName, type RawConfig } from "@ai-pr-review/shared";
import { RunProcessor, type RunnerDeps } from "./processor";
import {
  GitHubPublisher,
  type ConcludeInput,
  type PublishInput,
  type PublishOutcome,
  type Publisher,
} from "./publisher";

export { answer, createFakePublisherGitHub, file, modelFinding, type MockProvider, type MockReply };
export type { FakePublisherGitHub, FakePublisherSetup };
export { createMockProvider };

export const HEAD_SHA = "a".repeat(40);

/** REDIS_URL from the environment, then the repo-level .env, then the compose default. */
export function redisUrl(): string {
  if (!process.env.REDIS_URL) {
    const envFile = fileURLToPath(new URL("../../../.env", import.meta.url));
    if (existsSync(envFile)) process.loadEnvFile(envFile);
  }
  return process.env.REDIS_URL || "redis://localhost:6379";
}

export const KEYRING = new Keyring({ version: 1, key: randomBytes(32) });
export const API_KEY = "sk-worker-test-key-0123456789abcdef";

/** A key stored the way the api does it. */
export async function storeKey(
  t: TestDatabase,
  tenant: Tenant,
  provider: ProviderName = "deepseek",
  apiKey: string = API_KEY,
  keyring: Keyring = KEYRING,
): Promise<void> {
  const { ciphertext, keyVersion } = encryptSecret(
    apiKey,
    keyring,
    credentialContext({ installationId: tenant.installation.id }, provider),
  );
  await putProviderCredential(t.db, tenant.installation.id, {
    provider,
    ciphertext,
    keyVersion,
    last4: apiKey.slice(-4),
  });
}

export async function configure(
  t: TestDatabase,
  tenant: Tenant,
  repoConfig: RawConfig = {},
  installationConfig: RawConfig = {},
): Promise<void> {
  await upsertInstallationSettings(t.db, tenant.installation.id, {
    provider: "deepseek",
    model: "test-model",
    // The lifecycle tests are about one agent and one model call per run; Test Coverage and Security have tests of
    // their own (`coverage.test.ts` here, `security.test.ts` in core), and a test that wants one turns it back on.
    agents: { test_coverage: false, security: false },
    ...installationConfig,
  });
  if (Object.keys(repoConfig).length > 0) {
    await upsertRepoSettings(t.db, tenant.installation.id, tenant.repo.id, repoConfig);
  }
}

/** A tenant that is ready to be reviewed: provider and model configured, key stored. */
export async function readyTenant(
  t: TestDatabase,
  label: string,
  repoConfig: RawConfig = {},
): Promise<Tenant> {
  const tenant = await createTenant(t.db, label);
  await configure(t, tenant, repoConfig);
  await storeKey(t, tenant);
  return tenant;
}

export const queuedRun = (t: TestDatabase, tenant: Tenant, prNumber = 7) =>
  makeRun(t.db, tenant, { prNumber, headSha: HEAD_SHA });

/** One bug on line 2 of `src/a.ts`, which the default fake PR adds. */
export const bugAnswer = (title = "Off-by-one in add") =>
  answer(modelFinding({ title, file_path: "src/a.ts", start_line: 2, end_line: 2 }));

export const defaultFiles = () => [file("src/a.ts")];

export function fakeGitHub(setup: FakeGitHubSetup = {}) {
  const fake = createFakeGitHub({
    files: defaultFiles(),
    pull: { headSha: HEAD_SHA },
    ...setup,
  });
  return {
    calls: fake.calls,
    client: fake.client,
    access: { getClient: async (): Promise<ContextClient> => fake.client },
  };
}

/** Records the calls; answers like a publisher whose GitHub accepted everything. */
export class RecordingPublisher implements Publisher {
  readonly started: Run[] = [];
  readonly published: PublishInput[] = [];
  readonly concluded: ConcludeInput[] = [];
  async start(run: Run): Promise<number | undefined> {
    this.started.push(run);
    return undefined;
  }
  async publish(input: PublishInput): Promise<PublishOutcome> {
    this.published.push(input);
    return { kind: "published", warnings: [], degraded: false };
  }
  async conclude(input: ConcludeInput): Promise<void> {
    this.concluded.push(input);
  }
}

export const APP_LOGIN = "ai-review[bot]";
export const DASHBOARD_URL = "https://dash.example";

/** The real publisher against an in-memory GitHub that remembers what it was sent. */
export function realPublisher(t: TestDatabase, github: FakePublisherGitHub): GitHubPublisher {
  return new GitHubPublisher({
    db: t.db,
    github: { getClient: async () => github.client },
    publicUrl: DASHBOARD_URL,
    logger: createLogger({}, () => undefined),
    appLogin: APP_LOGIN,
  });
}

export interface Rig {
  processor: RunProcessor;
  signals: InMemoryRunSignals;
  publisher: RecordingPublisher;
  provider: MockProvider;
  github: ReturnType<typeof fakeGitHub>;
  /** Every line the processor logged. */
  logs: string[];
  /** The options `createProvider` was called with. */
  providerCalls: Array<{
    name: string;
    model: string;
    apiKey: string;
    baseUrl?: string | null | undefined;
  }>;
}

export interface RigOptions {
  replies?: MockReply[];
  github?: ReturnType<typeof fakeGitHub>;
  deps?: Partial<RunnerDeps>;
}

export function buildRig(t: TestDatabase, options: RigOptions = {}): Rig {
  const logs: string[] = [];
  const logger: Logger = createLogger({}, (line) => logs.push(line));
  const signals = new InMemoryRunSignals();
  const publisher = new RecordingPublisher();
  const provider = createMockProvider({ replies: options.replies ?? [bugAnswer()] });
  const github = options.github ?? fakeGitHub();
  const providerCalls: Rig["providerCalls"] = [];
  const processor = new RunProcessor({
    db: t.db,
    keyring: KEYRING,
    github: github.access,
    signals,
    publisher,
    logger,
    quotas: { runsPerDay: 1_000, tokensPerDay: 100_000_000 },
    heartbeatIntervalMs: 25,
    createProvider: (o): Provider => {
      providerCalls.push({ name: o.name, model: o.model, apiKey: o.apiKey, baseUrl: o.baseUrl });
      return provider;
    },
    ...options.deps,
  });
  return { processor, signals, publisher, provider, github, logs, providerCalls };
}

export const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Polls until `check` returns a value, or fails the test with `what`. */
export async function waitFor<T>(
  what: string,
  check: () => Promise<T | undefined | false>,
  timeoutMs = 15_000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}`);
    await sleep(25);
  }
}
