import type { LiveStatus } from "../hooks/useRunEvents";

const TEXT: Record<LiveStatus, string> = {
  connecting: "Connecting…",
  live: "Live",
  polling: "Refreshing every few seconds",
};

/** Says whether run changes arrive instantly (event stream) or by polling. Text, not just a coloured dot. */
export function LiveIndicator({ status }: { status: LiveStatus }) {
  return (
    <span
      data-live={status}
      className="text-muted inline-flex items-center gap-1.5 text-xs"
      title={
        status === "live"
          ? "Run changes appear as they happen"
          : status === "polling"
            ? "The live connection is down; the page refreshes by itself every few seconds"
            : "Opening the live connection"
      }
    >
      <span
        aria-hidden="true"
        className={`inline-block h-2 w-2 rounded-full ${
          status === "live" ? "bg-st-completed-fg" : "bg-muted"
        }`}
      />
      {TEXT[status]}
    </span>
  );
}
