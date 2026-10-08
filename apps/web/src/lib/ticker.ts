import { useSyncExternalStore } from "react";

/**
 * One shared clock per resolution: every relative time on the page re-renders from the same timer instead of
 * each owning an interval. The timer only runs while something is subscribed.
 */
function createTicker(intervalMs: number) {
  let now = Date.now();
  let timer: ReturnType<typeof setInterval> | undefined;
  const listeners = new Set<() => void>();
  return {
    subscribe(listener: () => void) {
      if (listeners.size === 0) {
        now = Date.now();
        timer = setInterval(() => {
          now = Date.now();
          listeners.forEach((l) => l());
        }, intervalMs);
      }
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
        if (listeners.size === 0 && timer) {
          clearInterval(timer);
          timer = undefined;
        }
      };
    },
    snapshot() {
      // Before anything subscribes the clock is not ticking: refresh it when it has gone stale, but keep the
      // value stable between calls (useSyncExternalStore requires that).
      if (listeners.size === 0 && Date.now() - now > intervalMs) now = Date.now();
      return now;
    },
  };
}

const minute = createTicker(15_000);
const second = createTicker(1_000);

/** The current time, refreshed every 15 seconds (for "5 minutes ago"). */
export const useNow = (): number => useSyncExternalStore(minute.subscribe, minute.snapshot);
/** The current time, refreshed every second (for the elapsed time of a running run). */
export const useSecondNow = (): number => useSyncExternalStore(second.subscribe, second.snapshot);
