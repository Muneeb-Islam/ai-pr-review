import { Redis } from "ioredis";

export type RedisRole = "producer" | "worker" | "subscriber";

/**
 * A Redis connection for one purpose. BullMQ workers and subscribers must not give up on a command
 * (`maxRetriesPerRequest: null`); a producer inside the api should fail fast so a webhook is answered with an
 * error and redelivered instead of hanging. Errors are swallowed here because ioredis emits one per
 * reconnect attempt; callers that care report health through their own checks.
 */
export function createRedisConnection(url: string, role: RedisRole): Redis {
  const redis = new Redis(url, {
    ...(role === "producer"
      ? { maxRetriesPerRequest: 2, enableOfflineQueue: false }
      : { maxRetriesPerRequest: null }),
    retryStrategy: (attempt) => Math.min(attempt * 500, 5000),
  });
  redis.on("error", () => undefined);
  return redis;
}
