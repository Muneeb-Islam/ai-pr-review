// Test harness for the dashboard API: the real app and a real PostgreSQL, with fake GitHub (OAuth, user and
// App calls), a controllable clock and in-memory rate limiting. Sign-in goes through the real OAuth routes.
import { randomBytes } from "node:crypto";
import { Keyring } from "@ai-pr-review/core";
import {
  createAppRoleHandle,
  createTenant,
  createTestDatabase,
  type Tenant,
  type TestDatabase,
} from "@ai-pr-review/db/testing";
import type { DbHandle } from "@ai-pr-review/db";
import { InMemoryRunSignals } from "@ai-pr-review/queue";
import { createLogger, InMemoryJobQueue } from "@ai-pr-review/shared";
import type { LightMyRequestResponse } from "fastify";
import { buildApp, type AppDeps } from "../app";
import type { PlatformConfig } from "../config";
import type { ProbeInput, ProbeResult, ProviderProbe } from "../credentials/probe";
import { RunEventHub } from "../events/source";
import { ApiMetrics } from "../metrics/registry";
import {
  GitHubUnavailableError,
  OAuthExchangeError,
  type GitHubAppApi,
  type GitHubProfile,
  type GitHubUserApi,
  type OrgRole,
  type RepoPermission,
  type UserInstallation,
  type UserRepository,
} from "../github/types";
import type { StreamTimings } from "../http/platform";
import { MemoryRateLimiter } from "../http/rateLimit";
import type { RepoFileReader, RepoFileState } from "../github/repoFile";
import { RunActions } from "../runs/actions";
import { FakeGateway, sign, SECRET as WEBHOOK_SECRET } from "../webhooks/testing";
import type { WebhookLimits } from "../webhooks/route";
import { WebhookService } from "../webhooks/service";
import type { QuotaCheck } from "../webhooks/types";
import type { Resolver } from "@ai-pr-review/core";

export const WEB_ORIGIN = "http://localhost:5173";
export const API_ORIGIN = "http://localhost:3000";

/** What the fake GitHub knows about one user. */
export interface FakeGitHubUser {
  id: number;
  login: string;
  installations: Array<{
    id: number;
    accountLogin: string;
    accountType: "user" | "organization";
    orgRole?: OrgRole;
    repos: UserRepository[];
  }>;
}

export class FakeGitHub implements GitHubUserApi, GitHubAppApi {
  readonly users = new Map<string, FakeGitHubUser>();
  /** `login|owner/repo` -> permission, answered to the App on a cache refresh. */
  readonly repoPermissions = new Map<string, RepoPermission>();
  /** `login|org` -> role, answered to the App on a cache refresh. */
  readonly orgRoles = new Map<string, OrgRole>();
  readonly usedCodes = new Set<string>();
  readonly verifiers: string[] = [];
  appCalls = 0;
  unavailable = false;
  slug: string | undefined = "ai-pr-review-test";

  private byToken(token: string): FakeGitHubUser {
    const login = token.replace(/^token-for-/, "");
    const user = this.users.get(login);
    if (!user) throw new GitHubUnavailableError();
    return user;
  }

  async exchangeCode(input: {
    code: string;
    redirectUri: string;
    codeVerifier: string;
  }): Promise<string> {
    if (this.unavailable) throw new GitHubUnavailableError();
    this.verifiers.push(input.codeVerifier);
    // `code-for-<login>` or `code-for-<login>~<n>`: GitHub issues a fresh code for every sign-in.
    const login = input.code.replace(/^code-for-/, "").split("~")[0]!;
    if (
      !input.code.startsWith("code-for-") ||
      !this.users.has(login) ||
      this.usedCodes.has(input.code)
    ) {
      throw new OAuthExchangeError();
    }
    this.usedCodes.add(input.code);
    return `token-for-${login}`;
  }

  async getUser(token: string): Promise<GitHubProfile> {
    const user = this.byToken(token);
    return { id: user.id, login: user.login, avatarUrl: `https://avatars.test/${user.login}` };
  }

  async listInstallations(token: string): Promise<UserInstallation[]> {
    return this.byToken(token).installations.map(({ id, accountLogin, accountType }) => ({
      id,
      accountLogin,
      accountType,
    }));
  }

  async listInstallationRepositories(
    token: string,
    installationId: number,
  ): Promise<UserRepository[]> {
    return this.byToken(token).installations.find((i) => i.id === installationId)?.repos ?? [];
  }

  async getOrgRole(a: string | number, b: string, c?: string): Promise<OrgRole> {
    // Two shapes: (userToken, org) at login, (installationId, org, login) on refresh.
    if (c === undefined) {
      const user = this.byToken(String(a));
      return user.installations.find((i) => i.accountLogin === b)?.orgRole ?? "none";
    }
    this.appCalls++;
    if (this.unavailable) throw new GitHubUnavailableError();
    return this.orgRoles.get(`${c}|${b}`) ?? "none";
  }

  async getRepoPermission(
    _installationId: number,
    repo: { owner: string; repo: string },
    login: string,
  ): Promise<RepoPermission> {
    this.appCalls++;
    if (this.unavailable) throw new GitHubUnavailableError();
    return this.repoPermissions.get(`${login}|${repo.owner}/${repo.repo}`) ?? "none";
  }

  async getAppSlug(): Promise<string> {
    if (!this.slug) throw new GitHubUnavailableError();
    return this.slug;
  }
}

export class FakeProbe implements ProviderProbe {
  readonly calls: ProbeInput[] = [];
  result: ProbeResult = { ok: true, message: "The provider accepted the key." };
  async check(input: ProbeInput): Promise<ProbeResult> {
    this.calls.push(input);
    return this.result;
  }
}

/** A GitHub gateway whose pull request has whatever number is asked for (the tests choose the head and the state). */
export class HarnessGateway extends FakeGateway {
  override async fetchPullRequest(
    githubInstallationId: number,
    repo: { owner: string; repo: string },
    prNumber: number,
  ) {
    const snapshot = await super.fetchPullRequest(githubInstallationId, repo, prNumber);
    return { ...snapshot, pr: { ...snapshot.pr, number: prNumber } };
  }
}

/** The repository file as the settings screen reads it; set `state` to what GitHub would answer. */
export class FakeRepoFile implements RepoFileReader {
  state: RepoFileState = {
    path: ".github/ai-pr-review.yml",
    status: "absent",
    config: {},
    message: null,
  };
  calls = 0;
  async read(): Promise<RepoFileState> {
    this.calls += 1;
    return this.state;
  }
}

export class Clock {
  constructor(private current = new Date("2026-10-02T10:00:00.000Z")) {}
  now = () => new Date(this.current);
  advance(ms: number): void {
    this.current = new Date(this.current.getTime() + ms);
  }
}

export interface HarnessOptions {
  config?: Partial<PlatformConfig>;
  /**
   * Run the endpoint handlers on a plain database role under the tenant row-level-security policies, the way
   * production does (default). `false` uses the test database's superuser, which ignores them.
   */
  rowLevelSecurity?: boolean;
  /** More of the app than the dashboard API: metrics, a route listener. */
  app?: Partial<Omit<AppDeps, "checks" | "platform" | "webhooks">>;
  /** Also serve `POST /webhooks/github` (secret `WEBHOOK_SECRET` of the webhook test helpers), with these limits. */
  webhooks?: { limits?: Partial<Omit<WebhookLimits, "limiter">>; quota?: QuotaCheck };
  resolveHost?: Resolver;
  /** Timings of the event stream. */
  stream?: Partial<StreamTimings>;
}

export interface Session {
  login: string;
  /** `Cookie` header value. */
  cookie: string;
  csrf: string;
  userId: string;
}

export interface Harness {
  t: TestDatabase;
  app: ReturnType<typeof buildApp>;
  github: FakeGitHub;
  probe: FakeProbe;
  repoFile: FakeRepoFile;
  /** What re-run talks to: the pull request GitHub reports, the Check Runs it creates, the queue and the signals. */
  gateway: HarnessGateway;
  queue: InMemoryJobQueue;
  signals: InMemoryRunSignals;
  clock: Clock;
  keyring: Keyring;
  config: PlatformConfig;
  /** Present when `options.webhooks` is set. */
  webhookService: WebhookService | undefined;
  /** Sends a signed webhook to the real route (no waiting for processing: `await h.webhookService.idle()`). */
  postWebhook(
    event: string,
    payload: unknown,
    options?: { deliveryId?: string; ip?: string; signature?: string },
  ): Promise<LightMyRequestResponse>;
  /** The api's own counters (`/metrics`). */
  metrics: ApiMetrics;
  /** The pool the handlers run on (a plain role unless `rowLevelSecurity: false`). */
  tenantPool: DbHandle | undefined;
  logLines: string[];
  rateLimiter: MemoryRateLimiter;
  /** Feed of `run.updated` events behind `GET /api/events`; `emit` one to simulate the worker. */
  events: RunEventHub;
  /** What every hostname resolves to in `base_url` checks; change it to simulate DNS answers. */
  dns: { addresses: string[] };
  signIn(login: string): Promise<Session>;
  request(
    session: Session | undefined,
    method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE",
    url: string,
    options?: {
      body?: unknown;
      csrf?: boolean | string;
      headers?: Record<string, string>;
      rawBody?: string;
    },
  ): Promise<LightMyRequestResponse>;
  close(): Promise<void>;
}

let codeCounter = 0;
export const SESSION_SECRET = "test-session-secret-0123456789abcdef-xyz";

export async function createHarness(options: HarnessOptions = {}): Promise<Harness> {
  const t = await createTestDatabase();
  const logLines: string[] = [];
  const logger = createLogger({}, (line) => logLines.push(line));
  const github = new FakeGitHub();
  const probe = new FakeProbe();
  const repoFile = new FakeRepoFile();
  const gateway = new HarnessGateway();
  const queue = new InMemoryJobQueue();
  const signals = new InMemoryRunSignals();
  const clock = new Clock();
  const dns = { addresses: ["104.18.2.55"] };
  const keyring = new Keyring({ version: 1, key: randomBytes(32) });
  const rateLimiter = new MemoryRateLimiter(() => clock.now().getTime());
  const events = new RunEventHub();
  const metrics = new ApiMetrics();
  const tenantPool =
    options.rowLevelSecurity === false
      ? undefined
      : await createAppRoleHandle(t, { scope: "tenant", max: 8 });
  const config: PlatformConfig = {
    publicUrl: WEB_ORIGIN,
    apiPublicUrl: API_ORIGIN,
    secureCookies: true,
    sessionSecret: SESSION_SECRET,
    githubClientId: "client-id-test",
    githubClientSecret: "client-secret-test",
    sessionIdleMs: 2 * 3_600_000,
    sessionAbsoluteMs: 7 * 24 * 3_600_000,
    accessCacheTtlMs: 10 * 60_000,
    rateLimitPerIpPerMinute: 1000,
    rateLimitPerUserPerMinute: 1000,
    quotas: { runsPerDay: 200, tokensPerDay: 2_000_000 },
    retentionDays: 90,
    platformAdmins: ["alice"],
    ...options.config,
  };

  const webhookService = options.webhooks
    ? new WebhookService({
        db: t.db,
        github: gateway,
        queue,
        signals,
        logger,
        publicUrl: WEB_ORIGIN,
        ...(options.webhooks.quota ? { quota: options.webhooks.quota } : {}),
      })
    : undefined;
  const app = buildApp({
    ...options.app,
    ...(webhookService
      ? {
          webhooks: {
            secret: WEBHOOK_SECRET,
            service: webhookService,
            logger,
            metrics,
            limits: {
              limiter: rateLimiter,
              perIpPerMinute: 1000,
              badSignaturePerMinute: 1000,
              perInstallationPerMinute: 1000,
              ...options.webhooks?.limits,
            },
          },
        }
      : {}),
    checks: { postgres: async () => {}, redis: async () => {} },
    platform: {
      db: t.db,
      ...(tenantPool ? { tenantDb: tenantPool.db } : {}),
      metrics,
      logger,
      config,
      userApi: github,
      appApi: github,
      keyring,
      rateLimiter,
      probe,
      repoFile,
      events,
      runActions: new RunActions({
        db: t.db,
        github: gateway,
        queue,
        signals,
        logger,
        publicUrl: WEB_ORIGIN,
      }),
      ...(options.stream ? { stream: options.stream } : {}),
      resolveHost: options.resolveHost ?? (async () => dns.addresses),
      now: clock.now,
    },
  });
  await app.ready();

  const cookiesOf = (res: LightMyRequestResponse) =>
    Object.fromEntries(res.cookies.map((c) => [c.name, c.value]));

  async function signIn(login: string): Promise<Session> {
    const start = await app.inject({ method: "GET", url: "/auth/github/login" });
    const state = new URL(String(start.headers.location)).searchParams.get("state")!;
    const oauthCookie = `aipr_oauth=${cookiesOf(start)["aipr_oauth"]}`;
    const done = await app.inject({
      method: "GET",
      url: `/auth/github/callback?code=code-for-${login}~${++codeCounter}&state=${state}`,
      headers: { cookie: oauthCookie },
    });
    const value = cookiesOf(done)["aipr_session"];
    if (!value) throw new Error(`Sign-in of ${login} failed: ${done.headers.location}`);
    const cookie = `aipr_session=${value}`;
    const me = await app.inject({ method: "GET", url: "/api/me", headers: { cookie } });
    const body = me.json() as { csrf_token: string; user: { id: string } };
    return { login, cookie, csrf: body.csrf_token, userId: body.user.id };
  }

  async function request(
    session: Session | undefined,
    method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE",
    url: string,
    opts: {
      body?: unknown;
      csrf?: boolean | string;
      headers?: Record<string, string>;
      rawBody?: string;
    } = {},
  ) {
    const headers: Record<string, string> = { ...opts.headers };
    if (session) headers["cookie"] = session.cookie;
    if (session && method !== "GET" && opts.csrf !== false) {
      headers["x-csrf-token"] = typeof opts.csrf === "string" ? opts.csrf : session.csrf;
    }
    const raw = opts.rawBody ?? (opts.body !== undefined ? JSON.stringify(opts.body) : undefined);
    if (raw !== undefined) headers["content-type"] = "application/json";
    return app.inject({ method, url, headers, ...(raw !== undefined ? { payload: raw } : {}) });
  }

  let deliveries = 0;
  async function postWebhook(
    event: string,
    payload: unknown,
    opts: { deliveryId?: string; ip?: string; signature?: string } = {},
  ) {
    const body = JSON.stringify(payload);
    return app.inject({
      method: "POST",
      url: "/webhooks/github",
      headers: {
        "content-type": "application/json",
        "x-github-event": event,
        "x-github-delivery": opts.deliveryId ?? `harness-delivery-${++deliveries}`,
        "x-hub-signature-256": opts.signature ?? sign(body),
      },
      payload: body,
      ...(opts.ip ? { remoteAddress: opts.ip } : {}),
    });
  }

  return {
    t,
    app,
    webhookService,
    postWebhook,
    github,
    probe,
    repoFile,
    gateway,
    queue,
    signals,
    clock,
    keyring,
    config,
    metrics,
    tenantPool,
    logLines,
    rateLimiter,
    events,
    dns,
    signIn,
    request,
    async close() {
      await app.close();
      await tenantPool?.close();
      await t.drop();
    },
  };
}

// ---------- a small world: two organisations and their people ----------

export interface World {
  alpha: Tenant;
  beta: Tenant;
  /** Org owner of alpha: admin everywhere in alpha. */
  alice: string;
  /** Plain member of alpha: viewer. */
  victor: string;
  /** Owner of beta, a different tenant. */
  bob: string;
  /** Has no installation at all. */
  carol: string;
}

/**
 * alpha has two repositories (`api`, `web`) and two people: alice (org owner) and victor (member, read access).
 * beta is another organisation with bob. carol has no access to anything.
 */
export async function createWorld(h: Harness): Promise<World> {
  const alpha = await createTenant(h.t.db, "alpha");
  const beta = await createTenant(h.t.db, "beta");
  let id = 1000;

  const orgFor = (tenant: Tenant, orgRole: OrgRole, adminOnRepos: boolean) => ({
    id: tenant.installation.githubInstallationId,
    accountLogin: tenant.installation.accountLogin,
    accountType: "organization" as const,
    orgRole,
    repos: [tenant.repo, tenant.repo2].map((repo) => ({
      id: repo.githubRepoId,
      fullName: repo.fullName,
      admin: adminOnRepos,
    })),
  });
  const addUser = (login: string, installations: FakeGitHubUser["installations"]) =>
    h.github.users.set(login, { id: ++id, login, installations });

  addUser("alice", [orgFor(alpha, "admin", true)]);
  addUser("victor", [orgFor(alpha, "member", false)]);
  addUser("bob", [orgFor(beta, "admin", true)]);
  addUser("carol", []);

  for (const tenant of [alpha, beta]) {
    const org = tenant.installation.accountLogin;
    h.github.orgRoles.set(`${tenant === alpha ? "alice" : "bob"}|${org}`, "admin");
    for (const repo of [tenant.repo, tenant.repo2]) {
      h.github.repoPermissions.set(
        `${tenant === alpha ? "alice" : "bob"}|${repo.fullName}`,
        "admin",
      );
    }
  }
  for (const repo of [alpha.repo, alpha.repo2]) {
    h.github.repoPermissions.set(`victor|${repo.fullName}`, "member");
  }
  h.github.orgRoles.set(`victor|${alpha.installation.accountLogin}`, "member");

  return { alpha, beta, alice: "alice", victor: "victor", bob: "bob", carol: "carol" };
}
