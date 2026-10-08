// A worker process for the chaos suite (`npm run test:chaos`): the real queue worker, run processor and sweeper against a
// real PostgreSQL and Redis, with a fake GitHub and a slow scripted model, so that the suite can kill it, or take its
// database or queue away, while reviews are in flight. Test code only; the production entry point is src/index.ts.
import { Keyring } from "@ai-pr-review/core";
import { createDb } from "@ai-pr-review/db";
import {
  BullJobQueue,
  createRedisConnection,
  InMemoryRunSignals,
  RedisSlotLimiter,
} from "@ai-pr-review/queue";
import { createLogger } from "@ai-pr-review/shared";
import { Sweeper } from "../src/sweeper";
import { buildRig, bugAnswer, fakeGitHub, sleep } from "../src/testing";
import { ReviewWorker } from "../src/worker";

const databaseUrl = process.env["DATABASE_URL"]!;
const redisUrl = process.env["REDIS_URL"]!;
const replyMs = Number(process.env["CHAOS_REPLY_MS"] ?? 1500);
const staleMs = Number(process.env["CHAOS_STALE_MS"] ?? 3000);
// The key the suite stored the provider key with.
const keyring = new Keyring({ version: 1, key: Buffer.from(process.env["CHAOS_KEY"]!, "base64") });

const logger = createLogger({ app: "chaos-worker", pid: process.pid }, (line) => {
  process.stdout.write(`${line}\n`);
});

const database = createDb(databaseUrl, { max: 8 });
database.pool.on("error", () => logger.warn("PostgreSQL connection error"));
const connection = createRedisConnection(redisUrl, "worker");
const queue = new BullJobQueue(connection, { attempts: 12, backoffMs: 300 });
const signals = new InMemoryRunSignals();

// A model that takes a while, so there is always something in flight to interrupt.
const rig = buildRig({ db: database.db } as never, {
  replies: [
    async () => {
      await sleep(replyMs);
      return bugAnswer();
    },
  ],
  github: fakeGitHub(),
  deps: { keyring },
});

const sweeper = new Sweeper({
  db: database.db,
  queue,
  signals,
  logger,
  staleAfterMs: staleMs,
  queuedGraceMs: 1000,
  maxRunAttempts: 6,
});

const worker = new ReviewWorker({
  db: database.db,
  processor: rig.processor,
  queue,
  connection,
  limiter: new RedisSlotLimiter(connection, { ttlMs: staleMs }),
  sweeper,
  sweepIntervalMs: 500,
  logger,
  concurrency: 3,
  installationConcurrency: 3,
  shutdownGraceMs: 2000,
  busyDelayMs: 100,
});
await worker.start();
logger.info("Chaos worker ready");

const stop = async () => {
  await worker.stop().catch(() => undefined);
  process.exit(0);
};
process.on("SIGTERM", () => void stop());
process.on("SIGINT", () => void stop());
