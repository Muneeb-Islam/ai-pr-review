// Fixed-window rate limiting, per key (an IP, a user, a user and an endpoint). The Redis store is shared by
// all api instances; the in-memory one is for tests and also the fallback when Redis is unreachable.
import type { Redis } from "ioredis";

export interface RateLimitResult {
  allowed: boolean;
  /** Seconds until the window resets (meaningful when `allowed` is false). */
  retryAfterSeconds: number;
}

export interface RateLimiter {
  hit(key: string, limit: number, windowMs: number): Promise<RateLimitResult>;
}

export class MemoryRateLimiter implements RateLimiter {
  private readonly windows = new Map<string, { count: number; resetAt: number }>();

  constructor(private readonly now: () => number = Date.now) {}

  async hit(key: string, limit: number, windowMs: number): Promise<RateLimitResult> {
    const now = this.now();
    if (this.windows.size > 10_000) {
      for (const [k, w] of this.windows) if (w.resetAt <= now) this.windows.delete(k);
    }
    let window = this.windows.get(key);
    if (!window || window.resetAt <= now) {
      window = { count: 0, resetAt: now + windowMs };
      this.windows.set(key, window);
    }
    window.count += 1;
    return {
      allowed: window.count <= limit,
      retryAfterSeconds: Math.ceil((window.resetAt - now) / 1000),
    };
  }
}

export class RedisRateLimiter implements RateLimiter {
  private readonly fallback = new MemoryRateLimiter();

  constructor(
    private readonly redis: Redis,
    private readonly prefix = "ratelimit:",
  ) {}

  async hit(key: string, limit: number, windowMs: number): Promise<RateLimitResult> {
    const redisKey = `${this.prefix}${key}`;
    try {
      const results = await this.redis.multi().incr(redisKey).pttl(redisKey).exec();
      const count = Number(results?.[0]?.[1]);
      let ttl = Number(results?.[1]?.[1]);
      if (!Number.isFinite(count)) throw new Error("unexpected Redis reply");
      if (!Number.isFinite(ttl) || ttl < 0) {
        await this.redis.pexpire(redisKey, windowMs);
        ttl = windowMs;
      }
      return { allowed: count <= limit, retryAfterSeconds: Math.ceil(ttl / 1000) };
    } catch {
      // Limiting must not become an outage (or a bypass): count locally while Redis is away.
      return this.fallback.hit(key, limit, windowMs);
    }
  }
}
