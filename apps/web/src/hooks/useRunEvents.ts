import { runUpdatedEventSchema } from "@ai-pr-review/shared/api";
import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { useApi } from "../app/api";
import { queryKeys } from "./queries";

/**
 * `live`: the event stream is open and updates arrive as they happen.
 * `polling`: the stream is down; the lists are refreshed every few seconds until it comes back.
 */
export type LiveStatus = "connecting" | "live" | "polling";

export interface RunEventsOptions {
  enabled?: boolean;
  /** Refresh interval while the stream is down. */
  pollMs?: number;
  /** How long to wait before opening a new connection after the browser gave up on the old one. */
  reconnectMs?: number;
  /** Tests inject a fake; browsers use the global. */
  eventSource?: typeof EventSource;
}

/**
 * PL-14: subscribes to `GET /api/events` and refreshes the queries a run change touches (the lists, the run
 * itself and the repositories' last run). The stream carries ids and a status only, so the data always comes
 * through the normal authorised endpoints. When the stream drops, polling takes over; a reconnect resyncs once
 * to catch what was missed.
 */
export function useRunEvents(options: RunEventsOptions = {}): LiveStatus {
  const { enabled = true, pollMs = 5_000, reconnectMs = 10_000 } = options;
  const api = useApi();
  const queryClient = useQueryClient();
  const [status, setStatus] = useState<LiveStatus>("connecting");
  const EventSourceImpl =
    options.eventSource ?? (typeof EventSource === "undefined" ? undefined : EventSource);

  useEffect(() => {
    if (!enabled || !EventSourceImpl) return;
    let source: EventSource | undefined;
    let pollTimer: ReturnType<typeof setInterval> | undefined;
    let reconnectTimer: ReturnType<typeof setTimeout> | undefined;
    let stopped = false;
    let hadGap = false;

    const refreshAll = () => {
      // A hidden tab catches up when it is shown again (refetchOnWindowFocus).
      if (typeof document !== "undefined" && document.visibilityState === "hidden") return;
      void queryClient.invalidateQueries({ queryKey: queryKeys.runs });
      void queryClient.invalidateQueries({ queryKey: ["run"] });
      void queryClient.invalidateQueries({ queryKey: ["history"] });
      void queryClient.invalidateQueries({ queryKey: queryKeys.repos });
    };

    const startPolling = () => {
      setStatus("polling");
      pollTimer ??= setInterval(refreshAll, pollMs);
    };
    const stopPolling = () => {
      if (pollTimer) clearInterval(pollTimer);
      pollTimer = undefined;
    };

    const connect = () => {
      if (stopped) return;
      const es = new EventSourceImpl(api.eventsUrl(), { withCredentials: true });
      source = es;

      es.addEventListener("open", () => {
        stopPolling();
        setStatus("live");
        if (hadGap) refreshAll();
        hadGap = false;
      });

      es.addEventListener("run.updated", (message) => {
        let data: unknown;
        try {
          data = JSON.parse((message as MessageEvent<string>).data);
        } catch {
          return;
        }
        const event = runUpdatedEventSchema.safeParse(data);
        if (!event.success) return;
        void queryClient.invalidateQueries({ queryKey: queryKeys.runs });
        void queryClient.invalidateQueries({ queryKey: queryKeys.run(event.data.run_id) });
        void queryClient.invalidateQueries({ queryKey: queryKeys.repos });
      });

      // The server ends a stream whose session ended: ask who we are again, the guard takes it from there.
      es.addEventListener("session.expired", () => {
        es.close();
        void queryClient.invalidateQueries({ queryKey: queryKeys.me });
      });

      es.addEventListener("error", () => {
        hadGap = true;
        startPolling();
        // The browser retries by itself unless it gave up (a 401, a 503): then we open a new connection later
        // and check the session meanwhile.
        if (es.readyState === 2 /* CLOSED */) {
          void queryClient.invalidateQueries({ queryKey: queryKeys.me });
          reconnectTimer = setTimeout(connect, reconnectMs);
        }
      });
    };

    connect();
    return () => {
      stopped = true;
      source?.close();
      stopPolling();
      if (reconnectTimer) clearTimeout(reconnectTimer);
    };
  }, [enabled, EventSourceImpl, api, queryClient, pollMs, reconnectMs]);

  return status;
}
