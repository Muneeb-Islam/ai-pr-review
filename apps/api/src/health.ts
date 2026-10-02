import type { Redis } from "ioredis";
import type { Pool } from "pg";

/** A readiness probe: resolves when the dependency answers, rejects otherwise. */
export type Check = () => Promise<void>;

export interface Checks {
  postgres: Check;
  redis: Check;
}

export function postgresCheck(pool: Pick<Pool, "query">): Check {
  return async () => {
    await pool.query("SELECT 1");
  };
}

export function redisCheck(redis: Pick<Redis, "ping">): Check {
  return async () => {
    const reply = await redis.ping();
    if (reply !== "PONG") throw new Error("unexpected reply");
  };
}

const CHECK_TIMEOUT_MS = 2000;

/** Runs one probe with a timeout and reduces it to "ok" | "fail". Errors are never exposed. */
export async function runCheck(check: Check, timeoutMs = CHECK_TIMEOUT_MS): Promise<"ok" | "fail"> {
  let timer: NodeJS.Timeout | undefined;
  try {
    await Promise.race([
      check(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("timeout")), timeoutMs);
      }),
    ]);
    return "ok";
  } catch {
    return "fail";
  } finally {
    clearTimeout(timer);
  }
}
