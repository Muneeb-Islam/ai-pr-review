import { GitHubAppAuth, keyringFromEnv } from "@ai-pr-review/core";
import { createDb } from "@ai-pr-review/db";
import {
  BullJobQueue,
  createRedisConnection,
  RedisRateLimitBoard,
  RedisRunSignals,
  RedisSlotLimiter,
} from "@ai-pr-review/queue";
import {
  createLogger,
  defaultLogFormat,
  EnvError,
  registerSecret,
  registerUrlSecret,
} from "@ai-pr-review/shared";
import { loadWorkerEnv } from "./env";
import { InstallationGoneError, InstallationSync } from "./installationSync";
import { DEFAULT_LIVENESS_FILE, startLiveness } from "./liveness";
import { GitHubPublisher } from "./publisher";
import { RunProcessor } from "./processor";
import { RetentionJob } from "./retention";
import { Sweeper } from "./sweeper";
import { ReviewWorker } from "./worker";

const logger = createLogger({ app: "worker" }, undefined, undefined, defaultLogFormat());

async function main(): Promise<void> {
  const env = loadWorkerEnv();
  // Anything that reaches a log line is masked, whatever the field is called.
  registerSecret(env.GITHUB_APP_PRIVATE_KEY);
  registerSecret(env.ENCRYPTION_KEY);
  registerSecret(env.ENCRYPTION_KEY_PREVIOUS);
  registerUrlSecret(env.DATABASE_URL);
  registerUrlSecret(env.REDIS_URL);

  const database = createDb(env.DATABASE_URL, { max: env.WORKER_CONCURRENCY + 4 });
  database.pool.on("error", () => logger.warn("PostgreSQL connection error"));

  const connection = createRedisConnection(env.REDIS_URL, "worker");
  connection.on("ready", () => logger.info("Connected to Redis"));

  const queue = new BullJobQueue(connection, { attempts: env.JOB_MAX_ATTEMPTS });
  const signals = new RedisRunSignals(connection);
  // The rate-limit headers of every GitHub response go to Redis, where the api's /metrics reads them.
  const rateLimits = new RedisRateLimitBoard(connection);
  const auth = new GitHubAppAuth(
    { appId: env.GITHUB_APP_ID, privateKey: env.GITHUB_APP_PRIVATE_KEY },
    { logger, onRateLimit: (sample) => rateLimits.record(sample) },
  );

  const github = {
    getClient: (installationId: number) => auth.getInstallationClient(installationId),
  };
  const appLogin = env.GITHUB_APP_SLUG ? `${env.GITHUB_APP_SLUG}[bot]` : undefined;
  const publisher = new GitHubPublisher({
    db: database.db,
    github,
    publicUrl: env.PUBLIC_URL,
    logger,
    appLogin,
  });

  const processor = new RunProcessor({
    db: database.db,
    keyring: keyringFromEnv(env),
    github,
    signals,
    publisher,
    logger,
    quotas: { runsPerDay: env.QUOTA_RUNS_PER_DAY, tokensPerDay: env.QUOTA_TOKENS_PER_DAY },
    heartbeatIntervalMs: env.RUN_HEARTBEAT_INTERVAL_SECONDS * 1000,
    ...(appLogin ? { appLogin } : {}),
  });

  const staleAfterMs = env.RUN_STUCK_TIMEOUT_SECONDS * 1000;
  const sweeper = new Sweeper({
    db: database.db,
    queue,
    signals,
    logger,
    publisher,
    staleAfterMs,
    queuedGraceMs: Math.max(staleAfterMs / 2, 30_000),
    maxRunAttempts: env.RUN_MAX_ATTEMPTS,
  });

  const worker = new ReviewWorker({
    db: database.db,
    processor,
    queue,
    connection,
    limiter: new RedisSlotLimiter(connection, { ttlMs: staleAfterMs }),
    sweeper,
    sweepIntervalMs: env.SWEEP_INTERVAL_SECONDS * 1000,
    logger,
    concurrency: env.WORKER_CONCURRENCY,
    installationConcurrency: env.WORKER_INSTALLATION_CONCURRENCY,
    shutdownGraceMs: env.SHUTDOWN_GRACE_SECONDS * 1000,
  });
  await worker.start();
  // The container's health check looks at this file (docs/operations.md).
  const stopLiveness = startLiveness(process.env["WORKER_LIVENESS_FILE"] ?? DEFAULT_LIVENESS_FILE);

  // Scheduled jobs (design §16): retention and the bookkeeping tables' own retention, and the reconciliation of
  // installations with GitHub. The stuck-run sweeper runs inside the ReviewWorker.
  const retention = new RetentionJob({
    db: database.db,
    logger,
    days: env.RETENTION_DAYS,
    auditDays: env.AUDIT_RETENTION_DAYS,
    webhookDays: env.WEBHOOK_DELIVERY_RETENTION_DAYS,
    // No session outlives the absolute timeout, so access cached longer ago than twice that is dead weight.
    accessCacheMaxAgeMs: Math.max(30 * 24, env.SESSION_ABSOLUTE_TIMEOUT_HOURS * 2) * 3_600_000,
  });
  retention.start(env.RETENTION_INTERVAL_MINUTES * 60_000);

  const installationSync = new InstallationSync({
    db: database.db,
    signals,
    logger,
    listRemoteRepositories: async (githubInstallationId) => {
      let client;
      try {
        client = await auth.getInstallationClient(githubInstallationId);
      } catch (err) {
        // GitHub answers 404 to a token request for an installation that does not exist (any more).
        if ((err as { status?: number }).status === 404) throw new InstallationGoneError();
        throw err;
      }
      const repositories = [];
      for (let page = 1; page <= 100; page++) {
        const { data } = await client.request("GET /installation/repositories", {
          per_page: 100,
          page,
        });
        for (const repo of data.repositories) {
          repositories.push({
            id: Number(repo.id),
            fullName: repo.full_name,
            isPrivate: repo.private,
            ...(repo.default_branch ? { defaultBranch: repo.default_branch } : {}),
          });
        }
        if (data.repositories.length < 100) break;
      }
      return repositories;
    },
  });
  installationSync.start(env.ACCESS_REFRESH_INTERVAL_MINUTES * 60_000);

  let stopping = false;
  const shutdown = async () => {
    if (stopping) return;
    stopping = true;
    retention.stop();
    installationSync.stop();
    stopLiveness();
    await worker.stop();
    await queue.close();
    connection.disconnect();
    await database.close();
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown());
  process.on("SIGTERM", () => void shutdown());
}

main().catch((err: unknown) => {
  logger.error(err instanceof EnvError ? err.message : "Worker failed to start");
  process.exit(1);
});
