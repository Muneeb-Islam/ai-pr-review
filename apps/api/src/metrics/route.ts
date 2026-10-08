import { timingSafeEqual } from "node:crypto";
import type { FastifyInstance } from "fastify";

export interface MetricsRouteOptions {
  /** `METRICS_TOKEN`. */
  token: string;
  /** The text exposition, collected at scrape time. */
  collect: () => Promise<string>;
}

const sameSecret = (given: string, expected: string): boolean => {
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
};

/**
 * `GET /metrics`, behind a bearer token (`Authorization: Bearer <METRICS_TOKEN>`). The endpoint exists only when a
 * token is configured: without one there is nothing to leave open by mistake. A wrong or missing token is a 401 with
 * no detail. The response carries no tenant content (see `collect.ts`) and is never cached.
 */
export async function metricsRoute(app: FastifyInstance, options: MetricsRouteOptions) {
  app.get("/metrics", async (request, reply) => {
    const header = request.headers.authorization;
    const given = header?.startsWith("Bearer ") ? header.slice("Bearer ".length).trim() : "";
    if (!sameSecret(given, options.token)) {
      return reply
        .code(401)
        .header("www-authenticate", "Bearer")
        .send({
          error: { code: "unauthorized", message: "A bearer token is required" },
        });
    }
    return reply
      .header("content-type", "text/plain; version=0.0.4; charset=utf-8")
      .header("cache-control", "no-store")
      .send(await options.collect());
  });
}
