// Wiring for the dashboard API: security headers, CORS, request ids and logging, rate limits, and the generic
// route registration that enforces, for every endpoint in the contract and in this order:
//
//   per-IP rate limit -> origin check (mutations) -> session (401) -> CSRF (mutations, 403)
//   -> per-user rate limit -> resource access by role (404 / 403) -> input validation (400) -> handler
//   -> response schema (strips anything the contract does not declare)
//
// Resource access runs before body validation so another tenant's resource is a 404 whatever the input is.
import type {
  Database,
  FindingWithRun,
  Installation,
  Repo,
  Run,
  StoredFinding,
} from "@ai-pr-review/db";
import {
  getFindingWithRun,
  getInstallation,
  getRepository,
  getRun,
  withInstallationScope,
} from "@ai-pr-review/db";
import { listAccessibleInstallationIds } from "@ai-pr-review/db/system";
import type { Keyring, Resolver } from "@ai-pr-review/core";
import {
  endpoints,
  formatIssues,
  isMutation,
  type EndpointDef,
  type EndpointName,
  type Endpoints,
  type InstallationRole,
  type Logger,
} from "@ai-pr-review/shared";
import fastifyCookie from "@fastify/cookie";
import fastifyCors from "@fastify/cors";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { z } from "zod";
import { AccessService } from "../auth/access";
import { SESSION_COOKIE, SessionService, type AuthContext } from "../auth/sessions";
import { webOrigin, type PlatformConfig } from "../config";
import type { ProviderProbe } from "../credentials/probe";
import type { RunEventSource } from "../events/source";
import type { RepoFileReader } from "../github/repoFile";
import type { ApiMetrics } from "../metrics/registry";
import type { RunActions } from "../runs/actions";
import type { GitHubAppApi, GitHubUserApi } from "../github/types";
import {
  forbidden,
  HttpError,
  notFound,
  tooManyRequests,
  unauthorized,
  validationError,
} from "./errors";
import type { RateLimiter } from "./rateLimit";

export interface PlatformDeps {
  db: Database;
  /**
   * A second pool for the endpoint handlers, with no row-level-security scope of its own (design §9): each handler
   * runs in a transaction that shows it only the signed-in user's installations. A handler that forgets a WHERE
   * clause then reads nothing outside them. Without it handlers use `db` (tests of unrelated things; a superuser
   * connection ignores the policies either way).
   */
  tenantDb?: Database;
  /** Counters for `/metrics`. */
  metrics?: ApiMetrics;
  logger: Logger;
  config: PlatformConfig;
  userApi: GitHubUserApi;
  appApi: GitHubAppApi;
  keyring: Keyring;
  rateLimiter: RateLimiter;
  probe: ProviderProbe;
  /** Live run events for `GET /api/events`. Without it the stream answers 503. */
  events?: RunEventSource;
  /** Re-run and cancel for `POST /api/runs/:id/rerun` and `/cancel`. Without it they answer 503. */
  runActions?: RunActions;
  /** Reads the repository file for the settings screen. Without it the screen says the file is unavailable. */
  repoFile?: RepoFileReader;
  /** Timings of the event stream (tests shorten them). */
  stream?: Partial<StreamTimings>;
  /** Hostname resolution for `base_url` checks (tests inject; defaults to DNS). */
  resolveHost?: Resolver;
  now?: () => Date;
}

export interface StreamTimings {
  /** A comment line this often keeps proxies from closing an idle stream. */
  heartbeatMs: number;
  /** How often the user's repository access and session are re-checked while a stream is open. */
  recheckMs: number;
}

/** Services shared by the handlers, built once from the deps. */
export interface Platform extends PlatformDeps {
  sessions: SessionService;
  access: AccessService;
}

type Def<K extends EndpointName> = Endpoints[K];
type Out<T, D> = D extends { [key in T & string]: infer S extends z.ZodType }
  ? z.output<S>
  : undefined;

type ResourceOf<D> = D extends { resource: "repo" }
  ? { repo: Repo; role: InstallationRole }
  : D extends { resource: "installation" }
    ? { installation: Installation; role: InstallationRole }
    : D extends { resource: "run" }
      ? { run: Run; repo: Repo; role: InstallationRole }
      : D extends { resource: "finding" }
        ? {
            finding: StoredFinding;
            run: FindingWithRun["run"];
            repo: Repo;
            role: InstallationRole;
          }
        : unknown;

export type HandlerContext<K extends EndpointName> = {
  request: FastifyRequest;
  reply: FastifyReply;
  platform: Platform;
  auth: Def<K> extends { auth: "session" } ? AuthContext : AuthContext | undefined;
  params: Out<"params", Def<K>>;
  query: Out<"query", Def<K>>;
  body: Out<"body", Def<K>>;
} & ResourceOf<Def<K>>;

/** Returns the response body, or undefined after the handler answered itself (a redirect). */
export type Handler<K extends EndpointName> = (
  ctx: HandlerContext<K>,
) => Promise<z.output<Def<K>["response"]> | undefined>;

export type Handlers = { [K in EndpointName]: Handler<K> };

const header = (value: string | string[] | undefined): string | undefined =>
  Array.isArray(value) ? value[0] : value;

/** Zod issues as `path: message` lines (the path is the field name, never a value). */
const problemsOf = (error: z.ZodError, raw: unknown): string[] => formatIssues(error.issues, raw);

function parse<T extends z.ZodType>(schema: T | undefined, raw: unknown): z.output<T> | undefined {
  if (!schema) return undefined;
  const result = schema.safeParse(raw ?? {});
  if (!result.success) throw validationError(problemsOf(result.error, raw));
  return result.data;
}

const MINUTE_MS = 60_000;

export function buildPlatform(deps: PlatformDeps): Platform {
  const now = deps.now ?? (() => new Date());
  return {
    ...deps,
    sessions: new SessionService(deps.db, deps.config, now),
    access: new AccessService({
      db: deps.db,
      userApi: deps.userApi,
      appApi: deps.appApi,
      logger: deps.logger,
      ttlMs: deps.config.accessCacheTtlMs,
      now,
    }),
  };
}

export function sessionCookieOptions(platform: Platform, maxAgeSeconds?: number) {
  return {
    httpOnly: true,
    secure: platform.config.secureCookies,
    sameSite: "lax" as const,
    path: "/",
    ...(maxAgeSeconds !== undefined ? { maxAge: maxAgeSeconds } : {}),
  };
}

/** Hooks and plugins every dashboard route needs. Call once, before registering endpoints. */
export async function installPlatformHooks(
  app: FastifyInstance,
  platform: Platform,
): Promise<void> {
  const { config, logger } = platform;
  const origin = webOrigin(config);
  const apiOrigin = new URL(config.apiPublicUrl).origin;

  await app.register(fastifyCookie);
  await app.register(fastifyCors, {
    origin: [origin],
    credentials: true,
    methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    allowedHeaders: ["content-type", "x-csrf-token", "x-request-id"],
    exposedHeaders: ["x-request-id", "retry-after"],
    maxAge: 600,
  });

  const isDashboardPath = (url: string) => url.startsWith("/api/") || url.startsWith("/auth/");

  app.addHook("onRequest", async (request, reply) => {
    reply.header("x-request-id", request.id);
    if (!isDashboardPath(request.url)) return;

    // Per-IP limit first: it also covers anonymous and failing requests.
    const ip = await platform.rateLimiter.hit(
      `ip:${request.ip}`,
      config.rateLimitPerIpPerMinute,
      MINUTE_MS,
    );
    if (!ip.allowed) {
      platform.metrics?.rateLimited.inc({ scope: "ip" });
      throw tooManyRequests(ip.retryAfterSeconds);
    }

    // A browser tells us where a request came from. A mutation from any other site is refused even before
    // the CSRF token is looked at (defence in depth; SameSite=Lax is the first line).
    if (isMutation(request.method as EndpointDef["method"])) {
      const from = header(request.headers.origin);
      if (from !== undefined && from !== origin && from !== apiOrigin) {
        throw new HttpError(403, "origin_not_allowed", "Requests from this origin are not allowed");
      }
    }
  });

  app.addHook("onSend", async (request, reply, payload) => {
    reply.header("x-content-type-options", "nosniff");
    reply.header("x-frame-options", "DENY");
    reply.header("referrer-policy", "no-referrer");
    // An API serves data, never documents: nothing may be framed, scripted or embedded from it.
    reply.header(
      "content-security-policy",
      "default-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
    );
    reply.header("cross-origin-resource-policy", "same-site");
    reply.header("permissions-policy", "camera=(), microphone=(), geolocation=()");
    if (config.secureCookies) {
      reply.header("strict-transport-security", "max-age=15552000; includeSubDomains");
    }
    if (isDashboardPath(request.url)) reply.header("cache-control", "no-store");
    return payload;
  });

  // One log line per request: the route pattern (not the URL: it can carry OAuth codes), status, timing.
  app.addHook("onResponse", async (request, reply) => {
    if (!isDashboardPath(request.url)) return;
    platform.metrics?.http.inc({
      route: request.routeOptions.url ?? "unmatched",
      status: `${Math.floor(reply.statusCode / 100)}xx`,
    });
    logger.info("Request", {
      request: request.id,
      method: request.method,
      route: request.routeOptions.url,
      status: reply.statusCode,
      ms: Math.round(reply.elapsedTime),
    });
  });
}

async function authenticate(
  platform: Platform,
  request: FastifyRequest,
): Promise<AuthContext | undefined> {
  return platform.sessions.resolve(request.cookies[SESSION_COOKIE]);
}

/** Registers one contract endpoint with its enforcement chain. */
export function registerEndpoint<K extends EndpointName>(
  app: FastifyInstance,
  name: K,
  handler: Handler<K>,
  platform: Platform,
): void {
  const def: EndpointDef = endpoints[name];
  const isSession = def.auth === "session";

  app.route({
    method: def.method,
    url: def.path,
    handler: async (request, reply) => {
      let auth: AuthContext | undefined;
      if (isSession) {
        auth = await authenticate(platform, request);
        if (!auth) throw unauthorized();
        if (isMutation(def.method)) {
          const token = header(request.headers["x-csrf-token"]);
          if (!platform.sessions.checkCsrf(auth.session, token)) {
            throw new HttpError(403, "csrf_invalid", "The CSRF token is missing or invalid");
          }
        }
        const user = await platform.rateLimiter.hit(
          `user:${auth.user.id}`,
          platform.config.rateLimitPerUserPerMinute,
          MINUTE_MS,
        );
        if (!user.allowed) {
          platform.metrics?.rateLimited.inc({ scope: "user" });
          throw tooManyRequests(user.retryAfterSeconds);
        }
        if (def.rateLimitPerMinute !== undefined) {
          const strict = await platform.rateLimiter.hit(
            `user:${auth.user.id}:${name}`,
            def.rateLimitPerMinute,
            MINUTE_MS,
          );
          if (!strict.allowed) throw tooManyRequests(strict.retryAfterSeconds);
        }
      }

      const params = parse(def.params, request.params) as { id?: string } | undefined;
      const resource =
        auth && def.resource ? await resolveResource(platform, auth, def, params?.id) : {};

      const ctx = {
        request,
        reply,
        platform,
        auth,
        params,
        query: parse(def.query, request.query),
        body: parse(def.body, request.body),
        ...resource,
      };
      const run = handler as (c: unknown) => Promise<unknown>;
      // Streams keep a connection for as long as the tab is open; everything else runs in one scoped transaction.
      const result =
        auth && platform.tenantDb && def.stream !== "sse"
          ? await withInstallationScope(
              platform.tenantDb,
              await listAccessibleInstallationIds(platform.db, auth.user.id),
              (db) => run({ ...ctx, platform: { ...platform, db } }),
            )
          : await run(ctx);
      if (reply.sent || result === undefined) return reply;

      const checked = def.response.safeParse(result);
      if (!checked.success) {
        // A handler produced something the contract does not allow: never send it.
        platform.logger.error("Response did not match its contract", { endpoint: name });
        throw new HttpError(500, "internal_error", "Internal error");
      }
      return reply.code(def.status ?? 200).send(checked.data);
    },
  });
}

/**
 * Loads the repository or installation behind `:id` for a signed-in user. Missing, malformed, inactive and
 * other tenants' ids are all the same 404; a visible resource with too little role is a 403.
 */
async function resolveResource(
  platform: Platform,
  auth: AuthContext,
  def: EndpointDef,
  id: string | undefined,
): Promise<Record<string, unknown>> {
  if (id === undefined) throw notFound();
  const user = { id: auth.user.id, login: auth.user.login };

  if (def.resource === "run") {
    // A run is reached through its repository: the installations are only a pre-filter, the repository
    // access (re-verified when stale) decides. Unknown, foreign and no-longer-visible runs are one 404.
    const installationIds = await listAccessibleInstallationIds(platform.db, user.id);
    const run = await getRun(platform.db, installationIds, id);
    if (!run) throw notFound();
    const access = await platform.access.getRepoAccess(user, run.repoId);
    if (!access || access.installationId !== run.installationId) throw notFound();
    const repo = await getRepository(platform.db, [access.installationId], run.repoId);
    if (!repo) throw notFound();
    if (def.role === "admin" && access.role !== "admin") throw forbidden();
    return { run, repo, role: access.role };
  }

  if (def.resource === "finding") {
    // Same rule as a run: found among the user's installations, then decided by access to its repository.
    const installationIds = await listAccessibleInstallationIds(platform.db, user.id);
    const found = await getFindingWithRun(platform.db, installationIds, id);
    if (!found) throw notFound();
    const access = await platform.access.getRepoAccess(user, found.finding.repoId);
    if (!access || access.installationId !== found.finding.installationId) throw notFound();
    const repo = await getRepository(platform.db, [access.installationId], found.finding.repoId);
    if (!repo) throw notFound();
    if (def.role === "admin" && access.role !== "admin") throw forbidden();
    return { finding: found.finding, run: found.run, repo, role: access.role };
  }

  if (def.resource === "repo") {
    const access = await platform.access.getRepoAccess(user, id);
    if (!access) throw notFound();
    const repo = await getRepository(platform.db, [access.installationId], id);
    if (!repo) throw notFound();
    if (def.role === "admin" && access.role !== "admin") throw forbidden();
    return { repo, role: access.role };
  }

  const access = await platform.access.getInstallationAccess(user, id);
  if (!access) throw notFound();
  const installation = await getInstallation(platform.db, [access.installationId], id);
  if (!installation) throw notFound();
  if (def.role === "admin" && access.role !== "admin") throw forbidden();
  return { installation, role: access.role };
}
