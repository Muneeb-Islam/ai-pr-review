// The GitHub rate-limit board behind /metrics: the lowest quotas win, quiet installations age out, and Redis loss is harmless.
import { Redis } from "ioredis";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { MemoryRateLimitBoard, RedisRateLimitBoard } from "./rateLimits";

const redisUrl = process.env["REDIS_URL"] ?? "redis://localhost:6379";
let redis: Redis;
let redisUp = true;

beforeAll(async () => {
  redis = new Redis(redisUrl, { lazyConnect: true, maxRetriesPerRequest: 1 });
  redis.on("error", () => undefined);
  try {
    await redis.connect();
    await redis.del("ai-pr-review:github-rate-limits");
  } catch {
    redisUp = false;
  }
});
afterAll(async () => {
  if (redisUp) await redis.del("ai-pr-review:github-rate-limits");
  redis.disconnect();
});

const NOW = Date.UTC(2030, 0, 1, 12, 0, 0);
const sample = (installationId: number, remaining: number, resetInSeconds = 600) => ({
  installationId,
  limit: 5000,
  remaining,
  resetAt: Math.floor(NOW / 1000) + resetInSeconds,
});

describe("RedisRateLimitBoard", () => {
  it("lists the installations closest to their limit first, bounded by the count asked for", async () => {
    expect(redisUp, "Redis must be running for the queue tests (npm run db:up)").toBe(true);
    const board = new RedisRateLimitBoard(redis, () => NOW);
    board.record(sample(1, 4000));
    board.record(sample(2, 12));
    board.record(sample(3, 900));
    await new Promise((r) => setTimeout(r, 100)); // writes are fire-and-forget
    const lowest = await board.lowest(2);
    expect(lowest.map((r) => [r.installationId, r.remaining])).toEqual([
      [2, 12],
      [3, 900],
    ]);
  });

  it("treats a window that has reset as full again, and drops samples older than an hour", async () => {
    const early = new RedisRateLimitBoard(redis, () => NOW);
    early.record(sample(4, 0, -5)); // reset already
    await new Promise((r) => setTimeout(r, 100));
    expect((await early.lowest(10)).find((r) => r.installationId === 4)?.remaining).toBe(5000);

    const later = new RedisRateLimitBoard(redis, () => NOW + 2 * 3_600_000);
    expect((await later.lowest(10)).find((r) => r.installationId === 4)).toBeUndefined();
  });

  it("ignores malformed entries and never throws when Redis is gone", async () => {
    await redis.hset("ai-pr-review:github-rate-limits", "999", "garbage");
    const board = new RedisRateLimitBoard(redis, () => NOW);
    expect((await board.lowest(10)).find((r) => r.installationId === 999)).toBeUndefined();

    const dead = new Redis("redis://127.0.0.1:1", {
      lazyConnect: true,
      maxRetriesPerRequest: 0,
      enableOfflineQueue: false,
    });
    dead.on("error", () => undefined);
    expect(() => new RedisRateLimitBoard(dead).record(sample(1, 1))).not.toThrow();
    dead.disconnect();
  });
});

describe("MemoryRateLimitBoard", () => {
  it("keeps the latest sample per installation, lowest ratio first", async () => {
    const board = new MemoryRateLimitBoard(() => NOW);
    board.record(sample(1, 100));
    board.record(sample(1, 50));
    board.record(sample(2, 4000));
    expect((await board.lowest(5)).map((r) => [r.installationId, r.remaining])).toEqual([
      [1, 50],
      [2, 4000],
    ]);
  });
});
