import Fastify, { type FastifyInstance } from "fastify";
import fp from "fastify-plugin";
import { runCheck, type Checks } from "./health";
import { installErrorHandling, newRequestId } from "./http/errors";
import { buildPlatform, installPlatformHooks, type PlatformDeps } from "./http/platform";
import { metricsRoute, type MetricsRouteOptions } from "./metrics/route";
import { registerRoutes } from "./routes";
import { webhookRoutes, type WebhookRouteOptions } from "./webhooks/route";

export interface AppDeps {
  checks: Checks;
  checkTimeoutMs?: number;
  /** The GitHub webhook endpoint. Tests of unrelated routes leave it out. */
  webhooks?: WebhookRouteOptions;
  /** Sign-in and the dashboard REST API. Tests of unrelated routes leave it out. */
  platform?: PlatformDeps;
  /** Behind a reverse proxy: take the client IP (rate limiting) from X-Forwarded-For. */
  trustProxy?: boolean;
  /** `GET /metrics` behind a bearer token. Without it the endpoint does not exist. */
  metrics?: MetricsRouteOptions;
  /** Called for every route as it is registered, including those of plugins (the route inventory test). */
  onRoute?: (route: { method: string | string[]; url: string }) => void;
}

/** Largest JSON body of a dashboard request. Settings and keys are tiny; webhooks set their own limit. */
const API_BODY_LIMIT_BYTES = 256 * 1024;

/** Builds the HTTP app. No listening and no I/O here, so tests can use `app.inject()`. */
export function buildApp(deps: AppDeps): FastifyInstance {
  const app = Fastify({
    logger: false,
    bodyLimit: API_BODY_LIMIT_BYTES,
    trustProxy: deps.trustProxy ?? false,
    genReqId: (request) => newRequestId(request.headers["x-request-id"]),
  });

  const { onRoute } = deps;
  if (onRoute) app.addHook("onRoute", (route) => onRoute({ method: route.method, url: route.url }));

  // Liveness: the process is up.
  app.get("/healthz", async () => ({ status: "ok" }));

  // Readiness: PostgreSQL and Redis both answer. Only "ok"/"fail" per dependency is returned.
  app.get("/readyz", async (_request, reply) => {
    const [postgres, redis] = await Promise.all([
      runCheck(deps.checks.postgres, deps.checkTimeoutMs),
      runCheck(deps.checks.redis, deps.checkTimeoutMs),
    ]);
    const ready = postgres === "ok" && redis === "ok";
    return reply.code(ready ? 200 : 503).send({
      status: ready ? "ready" : "unavailable",
      checks: { postgres, redis },
    });
  });

  if (deps.metrics) app.register(metricsRoute, deps.metrics);

  const { webhooks, platform } = deps;
  if (webhooks) {
    app.register(webhookRoutes, webhooks);
    // Graceful shutdown: let deliveries that were already accepted finish.
    app.addHook("onClose", async () => webhooks.service.idle());
  }

  if (platform) {
    installErrorHandling(app, platform.logger);
    const built = buildPlatform(platform);
    // Not encapsulated (fastify-plugin): the request id, security headers and CORS cover every route,
    // including unknown paths; only paths under /api and /auth are rate limited and kept out of caches.
    app.register(
      fp(async (scope) => {
        await installPlatformHooks(scope, built);
        registerRoutes(scope, built);
      }),
    );
  }

  return app;
}
