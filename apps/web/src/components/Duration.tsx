import type { RunStatus } from "@ai-pr-review/shared";
import { formatDuration } from "../lib/format";
import { useSecondNow } from "../lib/ticker";

interface TimedRun {
  status: RunStatus;
  queued_at: string;
  started_at: string | null;
  finished_at: string | null;
}

const ms = (iso: string) => new Date(iso).getTime();

/** How long a run took; for one that is still going, how long it has been going (ticking every second). */
export function RunDuration({ run }: { run: TimedRun }) {
  const now = useSecondNow();
  if (run.finished_at && run.started_at) {
    return <span>{formatDuration(ms(run.finished_at) - ms(run.started_at))}</span>;
  }
  if (run.status === "running" && run.started_at) {
    return <span>{formatDuration(now - ms(run.started_at))} so far</span>;
  }
  if (run.status === "queued") {
    return <span>Waiting {formatDuration(now - ms(run.queued_at))}</span>;
  }
  return <span className="text-muted">—</span>;
}
