import Fastify, { type FastifyInstance } from "fastify";
import { runCheck, type Checks } from "./health";

export interface AppDeps {
  checks: Checks;
  checkTimeoutMs?: number;
}

/** Builds the HTTP app. No listening and no I/O here, so tests can use `app.inject()`. */
export function buildApp(deps: AppDeps): FastifyInstance {
  const app = Fastify({ logger: false });

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

  return app;
}
