import { createGitHubGateway, GitHubAppAuth } from "@ai-pr-review/core";
import { createDb } from "@ai-pr-review/db";
import { createLogger, EnvError, registerSecret, type JobQueue } from "@ai-pr-review/shared";
import { Redis } from "ioredis";
import { buildApp } from "./app";
import { loadApiEnv } from "./env";
import { postgresCheck, redisCheck } from "./health";
import { WebhookService } from "./webhooks/service";

const logger = createLogger({ app: "api" });

async function main(): Promise<void> {
  const env = loadApiEnv();
  // Anything that reaches a log line is masked, whatever the field is called.
  registerSecret(env.GITHUB_WEBHOOK_SECRET);
  registerSecret(env.GITHUB_APP_PRIVATE_KEY);

  const database = createDb(env.DATABASE_URL, { max: 5 });
  const { pool } = database;
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

  const auth = new GitHubAppAuth(
    { appId: env.GITHUB_APP_ID, privateKey: env.GITHUB_APP_PRIVATE_KEY },
    { logger },
  );

  // The BullMQ queue arrives with the worker in Phase 8. Until then runs stay `queued` in the database
  // and the job is only logged, so nothing is lost: the worker will pick queued runs up.
  const queue: JobQueue = new LoggingJobQueue();

  const service = new WebhookService({
    db: database.db,
    github: createGitHubGateway(auth),
    queue,
    logger,
    publicUrl: env.PUBLIC_URL,
  });

  const app = buildApp({
    checks: { postgres: postgresCheck(pool), redis: redisCheck(redis) },
    webhooks: {
      secret: env.GITHUB_WEBHOOK_SECRET,
      service,
      logger,
      maxBodyBytes: env.WEBHOOK_MAX_BODY_BYTES,
    },
  });
  await app.listen({ host: env.HOST, port: env.PORT });
  logger.info("API listening", { host: env.HOST, port: env.PORT });

  const shutdown = async () => {
    await app.close();
    redis.disconnect();
    await database.close();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

/** Placeholder until Phase 8: logs the run id (an in-memory list would grow without bound). */
class LoggingJobQueue implements JobQueue {
  async enqueue(runId: string): Promise<void> {
    logger.info("Run queued (no worker queue yet)", { run: runId });
  }
}

main().catch((err: unknown) => {
  logger.error(err instanceof EnvError ? err.message : "API failed to start");
  process.exit(1);
});
