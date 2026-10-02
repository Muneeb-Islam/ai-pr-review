import { createLogger, EnvError } from "@ai-pr-review/shared";
import { Redis } from "ioredis";
import { loadWorkerEnv } from "./env";

const logger = createLogger({ app: "worker" });

async function main(): Promise<void> {
  const env = loadWorkerEnv();

  const redis = new Redis(env.REDIS_URL, {
    maxRetriesPerRequest: null, // required by BullMQ workers (Phase 8)
    retryStrategy: (attempt) => Math.min(attempt * 500, 5000),
  });
  let lastWarn = 0;
  redis.on("error", () => {
    // Throttled: ioredis emits an error per failed reconnect attempt.
    if (Date.now() - lastWarn > 10_000) {
      lastWarn = Date.now();
      logger.warn("Redis connection error; retrying");
    }
  });
  redis.on("ready", () => logger.info("Connected to Redis"));

  logger.info("Worker started; idling until jobs are added in Phase 8");

  const shutdown = () => {
    logger.info("Worker stopping");
    redis.disconnect();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((err: unknown) => {
  logger.error(err instanceof EnvError ? err.message : "Worker failed to start");
  process.exit(1);
});
