import { subscribeRunEvents, type RunUpdatedEvent, type Subscription } from "@ai-pr-review/queue";
import type { Redis } from "ioredis";

/**
 * Where `run.updated` events come from. One subscription per api process feeds every open dashboard stream;
 * the per-user filtering happens in the stream handler (events carry ids and a status, never run content).
 */
export interface RunEventSource {
  /** Returns the function that removes the listener. */
  subscribe(listener: (event: RunUpdatedEvent) => void): () => void;
}

/** Fan-out of one event feed to many listeners. A throwing listener never affects the others. */
export class RunEventHub implements RunEventSource {
  private readonly listeners = new Set<(event: RunUpdatedEvent) => void>();

  subscribe(listener: (event: RunUpdatedEvent) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  get size(): number {
    return this.listeners.size;
  }

  emit(event: RunUpdatedEvent): void {
    for (const listener of [...this.listeners]) {
      try {
        listener(event);
      } catch {
        // One broken stream must not stop the others.
      }
    }
  }
}

/** The Redis feed behind the hub (pub/sub channel `RUN_EVENTS_CHANNEL`). Close it on shutdown. */
export async function redisRunEventSource(
  connection: Redis,
): Promise<RunEventHub & { close(): Promise<void> }> {
  const hub = new RunEventHub();
  const subscription: Subscription = await subscribeRunEvents(connection, (event) =>
    hub.emit(event),
  );
  return Object.assign(hub, { close: () => subscription.close() });
}
