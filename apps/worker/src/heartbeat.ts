export interface HeartbeatOptions {
  intervalMs: number;
  /** Writes the heartbeat; false means the run is no longer ours. */
  beat: () => Promise<boolean>;
  /** Called once when `beat` answers false. */
  onLost: () => void;
  /** Called when `beat` throws (database unreachable); the next interval tries again. */
  onError?: (err: unknown) => void;
}

export interface Heartbeat {
  stop(): void;
}

/**
 * Calls `beat` every `intervalMs` until stopped. A beat that is still running when the next one is due is
 * skipped rather than stacked. The timer does not keep the process alive.
 */
export function startHeartbeat(options: HeartbeatOptions): Heartbeat {
  let stopped = false;
  let running = false;
  const timer = setInterval(() => {
    if (stopped || running) return;
    running = true;
    options
      .beat()
      .then((alive) => {
        if (!alive && !stopped) {
          stopped = true;
          clearInterval(timer);
          options.onLost();
        }
      })
      .catch((err: unknown) => options.onError?.(err))
      .finally(() => {
        running = false;
      });
  }, options.intervalMs);
  timer.unref();
  return {
    stop() {
      stopped = true;
      clearInterval(timer);
    },
  };
}
