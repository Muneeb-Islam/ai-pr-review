// A worker has no HTTP port, so its container's health check looks at a file instead: the worker touches it every few
// seconds from the event loop. A worker that hangs (a stuck event loop, a deadlock) stops touching it and the
// container is reported unhealthy and restarted. Whether it does useful work is what `/metrics` is for.
import { closeSync, openSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export const DEFAULT_LIVENESS_FILE = join(tmpdir(), "aipr-worker-alive");

/** Touches `path` now and then every `intervalMs`. Returns a function that stops it. */
export function startLiveness(path: string, intervalMs = 10_000): () => void {
  const touch = (): void => {
    try {
      const now = new Date();
      try {
        utimesSync(path, now, now);
      } catch {
        closeSync(openSync(path, "w")); // first touch: create it
      }
    } catch {
      // A read-only or full disk must not take the worker down; the health check will notice.
    }
  };
  touch();
  const timer = setInterval(touch, intervalMs);
  timer.unref();
  return () => clearInterval(timer);
}
