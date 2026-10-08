// GitHub rate limits as seen by every process (Phase 15, PL-16). The api and each worker record the headers GitHub
// sends with every response; `/metrics` reads the lowest remaining values from here. Redis holds only this
// operational telemetry and may be wiped at any time.
import type { Redis } from "ioredis";

const KEY = "ai-pr-review:github-rate-limits";
/** A sample older than this is not reported: the installation has been quiet and its window has reset. */
const MAX_AGE_SECONDS = 3600;

export interface RateLimitReading {
  installationId: number;
  limit: number;
  remaining: number;
  /** Unix seconds at which the window resets. */
  resetAt: number;
  /** Unix seconds at which the sample was taken. */
  seenAt: number;
}

export interface RateLimitBoard {
  record(sample: Omit<RateLimitReading, "seenAt">): void;
  /** The `count` installations with the least remaining quota, lowest first. Quiet installations are left out. */
  lowest(count: number): Promise<RateLimitReading[]>;
}

/** Fire-and-forget writes (a lost sample costs nothing) and a bounded read. */
export class RedisRateLimitBoard implements RateLimitBoard {
  constructor(
    private readonly redis: Redis,
    private readonly now: () => number = Date.now,
  ) {}

  record(sample: Omit<RateLimitReading, "seenAt">): void {
    const seenAt = Math.floor(this.now() / 1000);
    const value = `${sample.limit}|${sample.remaining}|${sample.resetAt}|${seenAt}`;
    this.redis
      .multi()
      .hset(KEY, String(sample.installationId), value)
      .expire(KEY, MAX_AGE_SECONDS * 2)
      .exec()
      .catch(() => undefined);
  }

  async lowest(count: number): Promise<RateLimitReading[]> {
    const all = await this.redis.hgetall(KEY);
    const nowSeconds = Math.floor(this.now() / 1000);
    const readings: RateLimitReading[] = [];
    for (const [id, value] of Object.entries(all)) {
      const [limit, remaining, resetAt, seenAt] = value.split("|").map(Number);
      if (![limit, remaining, resetAt, seenAt].every((n) => Number.isFinite(n))) continue;
      if (nowSeconds - seenAt! > MAX_AGE_SECONDS) continue;
      // A window that has reset is full again whatever the last sample said.
      const windowReset = resetAt! <= nowSeconds;
      readings.push({
        installationId: Number(id),
        limit: limit!,
        remaining: windowReset ? limit! : remaining!,
        resetAt: resetAt!,
        seenAt: seenAt!,
      });
    }
    return readings.sort((a, b) => a.remaining / a.limit - b.remaining / b.limit).slice(0, count);
  }
}

/** Keeps the latest sample per installation in memory (tests, and processes without Redis). */
export class MemoryRateLimitBoard implements RateLimitBoard {
  private readonly readings = new Map<number, RateLimitReading>();

  constructor(private readonly now: () => number = Date.now) {}

  record(sample: Omit<RateLimitReading, "seenAt">): void {
    this.readings.set(sample.installationId, {
      ...sample,
      seenAt: Math.floor(this.now() / 1000),
    });
  }

  async lowest(count: number): Promise<RateLimitReading[]> {
    return [...this.readings.values()]
      .sort((a, b) => a.remaining / a.limit - b.remaining / b.limit)
      .slice(0, count);
  }
}
