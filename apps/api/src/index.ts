import { createGitHubGateway, GitHubAppAuth, keyringFromEnv } from "@ai-pr-review/core";
import { createDb, getRowSecurityStatus } from "@ai-pr-review/db";
import {
  BullJobQueue,
  createRedisConnection,
  RedisRateLimitBoard,
  RedisRunSignals,
} from "@ai-pr-review/queue";
import { deleteExpiredSessions } from "@ai-pr-review/db/system";
import {
  createLogger,
  defaultLogFormat,
  EnvError,
  registerSecret,
  registerUrlSecret,
} from "@ai-pr-review/shared";
import { Redis } from "ioredis";
import { buildApp } from "./app";
import { platformConfigFromEnv } from "./config";
import { createProviderProbe } from "./credentials/probe";
import { loadApiEnv } from "./env";
import { redisRunEventSource } from "./events/source";
import { createGitHubAppApi } from "./github/appApi";
import { createRepoFileReader } from "./github/repoFile";
import { createGitHubUserApi } from "./github/userApi";
import { RedisRateLimiter } from "./http/rateLimit";
import { postgresCheck, redisCheck } from "./health";
import { collectMetrics } from "./metrics/collect";
import { ApiMetrics } from "./metrics/registry";
import { RunActions } from "./runs/actions";
import { createQuotaCheck } from "./webhooks/quota";
import { WebhookService } from "./webhooks/service";
import type { WebhookDeps } from "./webhooks/types";

const logger = createLogger({ app: "api" }, undefined, undefined, defaultLogFormat());

async function main(): Promise<void> {
  const env = loadApiEnv();
  // Anything that reaches a log line is masked, whatever the field is called.
  registerSecret(env.GITHUB_WEBHOOK_SECRET);
  registerSecret(env.GITHUB_APP_PRIVATE_KEY);
  registerSecret(env.GITHUB_CLIENT_SECRET);
  registerSecret(env.SESSION_SECRET);
  registerSecret(env.ENCRYPTION_KEY);
  registerSecret(env.ENCRYPTION_KEY_PREVIOUS);
  registerUrlSecret(env.DATABASE_URL);
  registerUrlSecret(env.REDIS_URL);
  registerSecret(env.METRICS_TOKEN);

  // Two pools on the same role (migration 0006): "system" announces the platform scope on every connection (sessions,
  // webhooks, re-run); "tenant" has none, so each endpoint handler sees only the signed-in user's installations.
  const database = createDb(env.DATABASE_URL, { max: 5 });
  const tenant = createDb(env.DATABASE_URL, { max: 10, scope: "tenant" });
  const { pool } = database;
  // Idle-client errors would otherwise crash the process; readiness reports the outage instead.
  pool.on("error", () => logger.warn("PostgreSQL connection error"));
  tenant.pool.on("error", () => logger.warn("PostgreSQL connection error"));
  void getRowSecurityStatus(database.db)
    .then((status) => {
      if (status.enforced) logger.info("Row-level security is enforced", { role: status.role });
      else {
        logger.warn(
          "Row-level security is NOT enforced: the database role is a superuser, has BYPASSRLS or owns the tables. Run the api and worker as a plain role (docs/operations.md)",
          { role: status.role },
        );
      }
    })
    .catch(() => undefined);

  const redis = new Redis(env.REDIS_URL, {
    lazyConnect: true,
    maxRetriesPerRequest: 1,
    enableOfflineQueue: false,
    retryStrategy: (attempt) => Math.min(attempt * 500, 5000),
  });
  redis.on("error", () => undefined); // reported through /readyz; avoids unhandled 'error' events
  redis.connect().catch(() => logger.warn("Redis not reachable yet; will keep retrying"));

  const rateLimits = new RedisRateLimitBoard(redis);
  const auth = new GitHubAppAuth(
    { appId: env.GITHUB_APP_ID, privateKey: env.GITHUB_APP_PRIVATE_KEY },
    { logger, onRateLimit: (sample) => rateLimits.record(sample) },
  );

  // Producer side of the review queue (the worker consumes it) and the Redis channels both processes use:
  // `run.updated` for the dashboard's live stream, `run.cancel` to stop a superseded run.
  const producer = createRedisConnection(env.REDIS_URL, "producer");
  const queue = new BullJobQueue(producer, { attempts: env.JOB_MAX_ATTEMPTS });
  const signals = new RedisRunSignals(producer);
  const events = await redisRunEventSource(createRedisConnection(env.REDIS_URL, "subscriber"));

  // One set of dependencies for everything that creates runs: webhooks, and re-run and cancel from the dashboard.
  const runDeps: WebhookDeps = {
    db: database.db,
    github: createGitHubGateway(auth),
    queue,
    signals,
    logger,
    publicUrl: env.PUBLIC_URL,
    // Daily quota and queue depth at enqueue (AC-23): a refused run is recorded as skipped with the reason.
    quota: createQuotaCheck({
      db: database.db,
      quotas: { runsPerDay: env.QUOTA_RUNS_PER_DAY, tokensPerDay: env.QUOTA_TOKENS_PER_DAY },
      queue: {
        perInstallation: env.QUEUE_MAX_QUEUED_PER_INSTALLATION,
        global: env.QUEUE_MAX_QUEUED_GLOBAL,
      },
    }),
  };
  const service = new WebhookService(runDeps);
  const rateLimiter = new RedisRateLimiter(redis);
  const counters = new ApiMetrics();

  const config = platformConfigFromEnv(env);
  const app = buildApp({
    trustProxy: env.TRUST_PROXY,
    checks: { postgres: postgresCheck(pool), redis: redisCheck(redis) },
    // `GET /metrics` exists only when a token is configured.
    ...(env.METRICS_TOKEN
      ? {
          metrics: {
            token: env.METRICS_TOKEN,
            collect: () =>
              collectMetrics({
                db: database.db,
                queue: {
                  counts: () => queue.counts(),
                  deadLetterCount: () => queue.deadLetterCount(),
                },
                rateLimits,
                rowSecurity: () => getRowSecurityStatus(database.db),
                counters,
                staleAfterSeconds: env.RUN_STUCK_TIMEOUT_SECONDS,
              }),
          },
        }
      : {}),
    platform: {
      db: database.db,
      tenantDb: tenant.db,
      metrics: counters,
      logger,
      config,
      userApi: createGitHubUserApi({
        clientId: env.GITHUB_CLIENT_ID,
        clientSecret: env.GITHUB_CLIENT_SECRET,
      }),
      appApi: createGitHubAppApi(auth),
      keyring: keyringFromEnv(env),
      rateLimiter,
      probe: createProviderProbe(),
      events,
      runActions: new RunActions(runDeps),
      repoFile: createRepoFileReader(auth),
    },
    webhooks: {
      secret: env.GITHUB_WEBHOOK_SECRET,
      service,
      logger,
      maxBodyBytes: env.WEBHOOK_MAX_BODY_BYTES,
      metrics: counters,
      limits: {
        limiter: rateLimiter,
        perIpPerMinute: env.WEBHOOK_RATE_LIMIT_PER_MINUTE,
        badSignaturePerMinute: env.WEBHOOK_BAD_SIGNATURE_LIMIT_PER_MINUTE,
        perInstallationPerMinute: env.WEBHOOK_INSTALLATION_LIMIT_PER_MINUTE,
      },
    },
  });
  await app.listen({ host: env.HOST, port: env.PORT });
  logger.info("API listening", { host: env.HOST, port: env.PORT });

  // Housekeeping: sessions past their absolute or idle end are removed hourly.
  const sweeper = setInterval(() => {
    deleteExpiredSessions(database.db, config.sessionIdleMs).catch(() =>
      logger.warn("Session cleanup failed"),
    );
  }, 3_600_000);
  sweeper.unref();

  const shutdown = async () => {
    clearInterval(sweeper);
    await app.close();
    await events.close();
    await queue.close();
    producer.disconnect();
    redis.disconnect();
    await tenant.close();
    await database.close();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((err: unknown) => {
  logger.error(err instanceof EnvError ? err.message : "API failed to start");
  process.exit(1);
});
