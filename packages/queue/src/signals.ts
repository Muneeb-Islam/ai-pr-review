import type { RunStatus } from "@ai-pr-review/shared";
import type { Redis } from "ioredis";
import { RUN_CONTROL_CHANNEL, RUN_EVENTS_CHANNEL } from "./names";

/** Announced after every state change of a run (design §7). Carries ids and the status, never run content. */
export interface RunUpdatedEvent {
  type: "run.updated";
  runId: string;
  installationId: string;
  repoId: string;
  status: RunStatus;
  at: string;
}

export type CancelReason = "superseded" | "cancelled";

/** From the api to every worker: stop this run if you are executing it. */
export interface RunCancelMessage {
  type: "run.cancel";
  runId: string;
  reason: CancelReason;
}

export type RunUpdate = Omit<RunUpdatedEvent, "type" | "at"> & { at?: Date };

/**
 * Outgoing signals. Implementations never reject: a lost pub/sub message must not fail a webhook or a run
 * (the worker's heartbeat notices a superseded run anyway, and the dashboard polls as a fallback).
 */
export interface RunSignals {
  publishUpdated(event: RunUpdate): Promise<void>;
  publishCancel(runId: string, reason: CancelReason): Promise<void>;
}

const toEvent = ({ at, ...rest }: RunUpdate): RunUpdatedEvent => ({
  type: "run.updated",
  ...rest,
  at: (at ?? new Date()).toISOString(),
});

export class RedisRunSignals implements RunSignals {
  constructor(private readonly redis: Redis) {}

  async publishUpdated(event: RunUpdate): Promise<void> {
    await this.send(RUN_EVENTS_CHANNEL, toEvent(event));
  }

  async publishCancel(runId: string, reason: CancelReason): Promise<void> {
    const message: RunCancelMessage = { type: "run.cancel", runId, reason };
    await this.send(RUN_CONTROL_CHANNEL, message);
  }

  private async send(channel: string, message: object): Promise<void> {
    try {
      await this.redis.publish(channel, JSON.stringify(message));
    } catch {
      // See `RunSignals`.
    }
  }
}

/** Records signals in memory (tests, and running the api without Redis). */
export class InMemoryRunSignals implements RunSignals {
  readonly updated: RunUpdatedEvent[] = [];
  readonly cancelled: RunCancelMessage[] = [];

  async publishUpdated(event: RunUpdate): Promise<void> {
    this.updated.push(toEvent(event));
  }

  async publishCancel(runId: string, reason: CancelReason): Promise<void> {
    this.cancelled.push({ type: "run.cancel", runId, reason });
  }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function parse(raw: string): Record<string, unknown> | undefined {
  try {
    const value: unknown = JSON.parse(raw);
    return typeof value === "object" && value !== null
      ? (value as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}

export function parseCancelMessage(raw: string): RunCancelMessage | undefined {
  const m = parse(raw);
  if (!m || m["type"] !== "run.cancel") return undefined;
  const runId = m["runId"];
  const reason = m["reason"];
  if (typeof runId !== "string" || !UUID.test(runId)) return undefined;
  if (reason !== "superseded" && reason !== "cancelled") return undefined;
  return { type: "run.cancel", runId, reason };
}

export function parseRunUpdatedEvent(raw: string): RunUpdatedEvent | undefined {
  const m = parse(raw);
  if (!m || m["type"] !== "run.updated") return undefined;
  const { runId, installationId, repoId, status, at } = m;
  if (
    typeof runId !== "string" ||
    typeof installationId !== "string" ||
    typeof repoId !== "string" ||
    typeof status !== "string" ||
    typeof at !== "string"
  ) {
    return undefined;
  }
  return { type: "run.updated", runId, installationId, repoId, status: status as RunStatus, at };
}

export interface Subscription {
  close(): Promise<void>;
}

/**
 * Subscribes on a dedicated connection (a subscribed Redis connection cannot run other commands). `connection`
 * is duplicated, so the caller keeps its own. Malformed messages are ignored.
 */
async function subscribe(
  connection: Redis,
  channel: string,
  onMessage: (raw: string) => void,
): Promise<Subscription> {
  const subscriber = connection.duplicate();
  subscriber.on("error", () => undefined);
  subscriber.on("message", (received: string, raw: string) => {
    if (received === channel) onMessage(raw);
  });
  // ioredis re-subscribes by itself after a reconnect.
  await subscriber.subscribe(channel);
  return {
    async close() {
      subscriber.removeAllListeners("message");
      subscriber.disconnect();
    },
  };
}

export function subscribeRunControl(
  connection: Redis,
  handler: (message: RunCancelMessage) => void,
): Promise<Subscription> {
  return subscribe(connection, RUN_CONTROL_CHANNEL, (raw) => {
    const message = parseCancelMessage(raw);
    if (message) handler(message);
  });
}

export function subscribeRunEvents(
  connection: Redis,
  handler: (event: RunUpdatedEvent) => void,
): Promise<Subscription> {
  return subscribe(connection, RUN_EVENTS_CHANNEL, (raw) => {
    const event = parseRunUpdatedEvent(raw);
    if (event) handler(event);
  });
}
