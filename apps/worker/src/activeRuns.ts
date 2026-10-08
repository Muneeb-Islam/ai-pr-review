/** Why a running review was told to stop. */
export type StopReason = "superseded" | "cancelled" | "lost" | "shutdown";

/**
 * The runs this process is executing, each with its `AbortController` (PL-06). `run.cancel` messages from the
 * api, a failed heartbeat and a shutdown all end up in `stop`; the engine and the GitHub calls watch the
 * signal between stages.
 */
export class ActiveRuns {
  private readonly controllers = new Map<string, AbortController>();

  register(runId: string): AbortController {
    const controller = new AbortController();
    this.controllers.set(runId, controller);
    return controller;
  }

  unregister(runId: string): void {
    this.controllers.delete(runId);
  }

  /** True if this process was executing the run. */
  stop(runId: string, reason: StopReason): boolean {
    const controller = this.controllers.get(runId);
    if (!controller) return false;
    if (!controller.signal.aborted) controller.abort(reason);
    return true;
  }

  stopAll(reason: StopReason): void {
    for (const id of [...this.controllers.keys()]) this.stop(id, reason);
  }

  get size(): number {
    return this.controllers.size;
  }
}

/** The reason a signal was aborted with, if it was one of ours. */
export function stopReason(signal: AbortSignal): StopReason | undefined {
  const reason: unknown = signal.reason;
  return reason === "superseded" ||
    reason === "cancelled" ||
    reason === "lost" ||
    reason === "shutdown"
    ? reason
    : undefined;
}
