// Chaos checks (Phase 15, design §7 and §16): reviews are in flight when the worker is killed, when Redis is stopped or
// loses everything, and when PostgreSQL is stopped. Every run must still reach an end, exactly once: no run stuck, no
// agent run or finding stored twice. The worker is a real separate process (`scripts/chaos-worker.ts`) and the databases
// are throwaway Docker containers that this suite starts and removes. Run with `npm run test:chaos`.
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";
import { Keyring } from "@ai-pr-review/core";
import { createDb, runMigrations } from "@ai-pr-review/db";
import { createTenant, type Tenant } from "@ai-pr-review/db/testing";
import { BullJobQueue, createRedisConnection } from "@ai-pr-review/queue";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { configure, HEAD_SHA, storeKey } from "../src/testing";
import { makeRun } from "@ai-pr-review/db/testing";

const suffix = randomBytes(3).toString("hex");
const PG = `aipr-chaos-pg-${suffix}`;
const REDIS = `aipr-chaos-redis-${suffix}`;
const RUNS = 12;
const key = randomBytes(32);
const keyring = new Keyring({ version: 1, key });

const docker = (...args: string[]): string =>
  execFileSync("docker", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();

const dockerAvailable = (() => {
  try {
    docker("version", "--format", "{{.Server.Version}}");
    return true;
  } catch {
    return false;
  }
})();

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const hostPort = (container: string, port: number): number =>
  Number(docker("port", container, `${port}/tcp`).split("\n")[0]!.split(":").pop());

async function waitUntil(what: string, check: () => Promise<boolean> | boolean, ms = 60_000) {
  const deadline = Date.now() + ms;
  for (;;) {
    try {
      if (await check()) return;
    } catch {
      // not ready yet
    }
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}`);
    await sleep(250);
  }
}

let databaseUrl = "";
let redisUrl = "";
let handle: ReturnType<typeof createDb>;
let tenant: Tenant;
const children: ChildProcess[] = [];
const worker = fileURLToPath(new URL("..", import.meta.url));

function startWorker(): ChildProcess {
  // One process (`--import tsx`, not the tsx wrapper), so killing it kills the worker and nothing else survives it.
  const child = spawn(process.execPath, ["--import", "tsx", "scripts/chaos-worker.ts"], {
    cwd: worker,
    env: {
      PATH: process.env["PATH"] ?? "",
      DATABASE_URL: databaseUrl,
      REDIS_URL: redisUrl,
      CHAOS_KEY: key.toString("base64"),
      CHAOS_REPLY_MS: "1500",
      CHAOS_STALE_MS: "3000",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  // CHAOS_DEBUG=1 shows what the worker processes say.
  const show = process.env["CHAOS_DEBUG"]
    ? (data: Buffer) => process.stdout.write(`[worker ${child.pid}] ${data}`)
    : () => undefined;
  child.stdout?.on("data", show);
  child.stderr?.on("data", show);
  children.push(child);
  return child;
}

const kill = (child: ChildProcess) => {
  child.kill("SIGKILL");
};

/** Creates `count` queued runs for distinct pull requests and hands each to the queue, like the api does. */
async function queueRuns(count: number, first: number): Promise<string[]> {
  const producer = createRedisConnection(redisUrl, "producer");
  const queue = new BullJobQueue(producer, { attempts: 12, backoffMs: 300 });
  const ids: string[] = [];
  try {
    for (let i = 0; i < count; i++) {
      const run = await makeRun(handle.db, tenant, { prNumber: first + i, headSha: HEAD_SHA });
      ids.push(run.id);
      await queue.enqueue(run.id);
    }
  } finally {
    await queue.close();
    producer.disconnect();
  }
  return ids;
}

const statuses = async (ids: string[]) =>
  (
    await handle.pool.query<{ id: string; status: string }>(
      "select id, status from review_runs where id = any($1)",
      [ids],
    )
  ).rows;

const countBy = async (ids: string[], status: string) =>
  (await statuses(ids)).filter((r) => r.status === status).length;

/** The outcome that matters: every run reached an end, and nothing was stored twice. */
async function expectExactlyOnce(ids: string[]) {
  await waitUntil(
    `all ${ids.length} runs to finish`,
    async () => (await statuses(ids)).every((r) => r.status !== "queued" && r.status !== "running"),
    150_000,
  );
  const final = await statuses(ids);
  const reasons = (
    await handle.pool.query<{ status_reason: string | null }>(
      "select distinct status_reason from review_runs where id = any($1) and status <> 'completed'",
      [ids],
    )
  ).rows.map((r) => r.status_reason);
  expect(final.map((r) => r.status).sort(), `reasons: ${JSON.stringify(reasons)}`).toEqual(
    Array(ids.length).fill("completed"),
  );

  const agentRuns = await handle.pool.query(
    "select run_id, count(*)::int as n from agent_runs where run_id = any($1) group by run_id",
    [ids],
  );
  expect(agentRuns.rows).toHaveLength(ids.length);
  expect(agentRuns.rows.every((r) => r.n === 1)).toBe(true);

  const findings = await handle.pool.query(
    "select run_id, count(*)::int as n from findings where run_id = any($1) group by run_id",
    [ids],
  );
  expect(findings.rows).toHaveLength(ids.length);
  expect(findings.rows.every((r) => r.n === 1)).toBe(true);

  // No run was queued twice for the same pull request and commit.
  const dup = await handle.pool.query(
    "select pr_number, count(*)::int as n from review_runs where id = any($1) group by pr_number having count(*) > 1",
    [ids],
  );
  expect(dup.rows).toEqual([]);
}

describe.skipIf(!dockerAvailable)(
  "chaos: reviews survive the loss of a worker, Redis and PostgreSQL",
  () => {
    beforeAll(async () => {
      docker(
        "run",
        "-d",
        "--name",
        PG,
        "-e",
        "POSTGRES_USER=aipr",
        "-e",
        "POSTGRES_PASSWORD=aipr",
        "-e",
        "POSTGRES_DB=aipr",
        "-p",
        "127.0.0.1::5432",
        "postgres:17-alpine",
      );
      docker("run", "-d", "--name", REDIS, "-p", "127.0.0.1::6379", "redis:7-alpine");
      databaseUrl = `postgres://aipr:aipr@127.0.0.1:${hostPort(PG, 5432)}/aipr`;
      redisUrl = `redis://127.0.0.1:${hostPort(REDIS, 6379)}`;
      await waitUntil("PostgreSQL", () => {
        docker("exec", PG, "pg_isready", "-U", "aipr", "-d", "aipr");
        return true;
      });
      // pg_isready can answer during the init restart: wait until a real connection works.
      await waitUntil("a PostgreSQL connection", async () => {
        const probe = createDb(databaseUrl, { max: 1 });
        try {
          await probe.pool.query("select 1");
          return true;
        } finally {
          await probe.close();
        }
      });
      await waitUntil("Redis", () => docker("exec", REDIS, "redis-cli", "ping") === "PONG");

      handle = createDb(databaseUrl, { max: 4 });
      handle.pool.on("error", () => undefined);
      await runMigrations(handle.db);
      tenant = await createTenant(handle.db, "chaos");
      await configure({ db: handle.db } as never, tenant);
      await storeKey({ db: handle.db } as never, tenant, "deepseek", undefined, keyring);
    }, 240_000);

    afterAll(async () => {
      for (const child of children) kill(child);
      await handle?.close().catch(() => undefined);
      for (const name of [PG, REDIS]) {
        try {
          docker("rm", "-f", name);
        } catch {
          // already gone
        }
      }
    });

    it("a worker killed with SIGKILL in the middle of reviews: the sweeper hands its runs to the next worker", async () => {
      const ids = await queueRuns(RUNS, 1000);
      const first = startWorker();
      await waitUntil("reviews in flight", async () => (await countBy(ids, "running")) >= 2);
      kill(first); // no graceful shutdown, no chance to hand anything back

      // Nothing is working on those runs now: they stay "running" until the heartbeat expires.
      expect(await countBy(ids, "running")).toBeGreaterThanOrEqual(1);
      startWorker();
      await expectExactlyOnce(ids);
    });

    it("Redis stopped for a few seconds and started again, with reviews in flight", async () => {
      const ids = await queueRuns(RUNS, 2000);
      startWorker();
      await waitUntil("reviews in flight", async () => (await countBy(ids, "running")) >= 2);
      docker("stop", REDIS);
      await sleep(5000);
      docker("start", REDIS);
      await waitUntil("Redis", () => docker("exec", REDIS, "redis-cli", "ping") === "PONG");
      await expectExactlyOnce(ids);
    });

    it("Redis destroyed and replaced by an empty one: queued runs are re-queued from the database", async () => {
      // Runs are created in the database and handed to the queue, then the queue is wiped before any worker looked at it.
      const ids = await queueRuns(RUNS, 3000);
      docker("rm", "-f", REDIS);
      docker(
        "run",
        "-d",
        "--name",
        REDIS,
        "-p",
        `127.0.0.1:${new URL(redisUrl).port}:6379`,
        "redis:7-alpine",
      );
      await waitUntil("the new Redis", () => docker("exec", REDIS, "redis-cli", "ping") === "PONG");
      // The workers that are running (from earlier tests) reconnect to an empty Redis: nothing is queued there any more.
      await expectExactlyOnce(ids);
    });

    it("PostgreSQL stopped for a few seconds and started again, with reviews in flight", async () => {
      const ids = await queueRuns(RUNS, 4000);
      await waitUntil("reviews in flight", async () => (await countBy(ids, "running")) >= 2);
      docker("stop", PG);
      await sleep(4000);
      docker("start", PG);
      await waitUntil("PostgreSQL", async () => {
        const probe = createDb(databaseUrl, { max: 1 });
        probe.pool.on("error", () => undefined);
        try {
          await probe.pool.query("select 1");
          return true;
        } finally {
          await probe.close();
        }
      });
      await expectExactlyOnce(ids);
    });
  },
);
