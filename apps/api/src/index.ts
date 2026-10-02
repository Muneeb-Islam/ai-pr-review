import { createLogger, EnvError } from "@ai-pr-review/shared";
import { Redis } from "ioredis";
import pg from "pg";
import { buildApp } from "./app";
import { loadApiEnv } from "./env";
import { postgresCheck, redisCheck } from "./health";

const logger = createLogger({ app: "api" });

async function main(): Promise<void> {
  const env = loadApiEnv();

  const pool = new pg.Pool({
    connectionString: env.DATABASE_URL,
    max: 5,
    connectionTimeoutMillis: 2000,
  });
  // Idle-client errors would otherwise crash the process; readiness reports the outage instead.
  pool.on("error", () => logger.warn("PostgreSQL connection error"));

  const redis = new Redis(env.REDIS_URL, {
    lazyConnect: true,
    maxRetriesPerRequest: 1,
    enableOfflineQueue: false,
    retryStrategy: (attempt) => Math.min(attempt * 500, 5000),
  });
  redis.on("error", () => undefined); // reported through /readyz; avoids unhandled 'error' events
  redis.connect().catch(() => logger.warn("Redis not reachable yet; will keep retrying"));

  const app = buildApp({ checks: { postgres: postgresCheck(pool), redis: redisCheck(redis) } });
  await app.listen({ host: env.HOST, port: env.PORT });
  logger.info("API listening", { host: env.HOST, port: env.PORT });

  const shutdown = async () => {
    await app.close();
    redis.disconnect();
    await pool.end();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((err: unknown) => {
  logger.error(err instanceof EnvError ? err.message : "API failed to start");
  process.exit(1);
});
