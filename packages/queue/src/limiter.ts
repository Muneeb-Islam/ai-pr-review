import type { Redis } from "ioredis";

/**
 * A counting semaphore keyed by name, shared by every worker process. Slots expire, so a worker that dies
 * holding one frees it by itself after `ttlMs`; a live holder renews it from its heartbeat.
 */
export interface SlotLimiter {
  /** True if `holder` now holds one of the `cap` slots of `key` (also true if it already did). */
  acquire(key: string, holder: string, cap: number): Promise<boolean>;
  /** Extends a held slot. */
  renew(key: string, holder: string): Promise<void>;
  release(key: string, holder: string): Promise<void>;
}

/**
 * Sorted set per key: member = holder, score = expiry in Redis time (so worker clocks do not matter).
 * One script does expire-check-add atomically.
 */
const ACQUIRE = `
local t = redis.call('TIME')
local now = tonumber(t[1]) * 1000 + math.floor(tonumber(t[2]) / 1000)
redis.call('ZREMRANGEBYSCORE', KEYS[1], '-inf', now)
local held = redis.call('ZSCORE', KEYS[1], ARGV[1])
if (not held) and redis.call('ZCARD', KEYS[1]) >= tonumber(ARGV[2]) then
  return 0
end
redis.call('ZADD', KEYS[1], now + tonumber(ARGV[3]), ARGV[1])
redis.call('PEXPIRE', KEYS[1], tonumber(ARGV[3]) * 2)
return 1
`;

const RENEW = `
local t = redis.call('TIME')
local now = tonumber(t[1]) * 1000 + math.floor(tonumber(t[2]) / 1000)
if redis.call('ZSCORE', KEYS[1], ARGV[1]) then
  redis.call('ZADD', KEYS[1], now + tonumber(ARGV[2]), ARGV[1])
  redis.call('PEXPIRE', KEYS[1], tonumber(ARGV[2]) * 2)
end
return 1
`;

export class RedisSlotLimiter implements SlotLimiter {
  constructor(
    private readonly redis: Redis,
    private readonly options: { prefix?: string; ttlMs?: number } = {},
  ) {}

  private get ttlMs(): number {
    return this.options.ttlMs ?? 60_000;
  }

  private redisKey(key: string): string {
    return `${this.options.prefix ?? "ai-pr-review:slots"}:${key}`;
  }

  async acquire(key: string, holder: string, cap: number): Promise<boolean> {
    const granted = await this.redis.eval(ACQUIRE, 1, this.redisKey(key), holder, cap, this.ttlMs);
    return granted === 1;
  }

  async renew(key: string, holder: string): Promise<void> {
    await this.redis.eval(RENEW, 1, this.redisKey(key), holder, this.ttlMs);
  }

  async release(key: string, holder: string): Promise<void> {
    await this.redis.zrem(this.redisKey(key), holder);
  }
}

/** Single-process limiter for tests and for running one worker without Redis semantics. */
export class MemorySlotLimiter implements SlotLimiter {
  private readonly held = new Map<string, Set<string>>();

  async acquire(key: string, holder: string, cap: number): Promise<boolean> {
    const set = this.held.get(key) ?? new Set<string>();
    if (!set.has(holder) && set.size >= cap) return false;
    set.add(holder);
    this.held.set(key, set);
    return true;
  }

  async renew(): Promise<void> {}

  async release(key: string, holder: string): Promise<void> {
    this.held.get(key)?.delete(holder);
  }
}
