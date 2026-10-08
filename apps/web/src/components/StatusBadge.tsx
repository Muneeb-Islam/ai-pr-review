import type { RunStatus } from "@ai-pr-review/shared";
import type { ReactNode } from "react";
import { STATUS_LABELS } from "../lib/format";
import {
  AlertIcon,
  CheckIcon,
  ClockIcon,
  CrossIcon,
  SkipIcon,
  SpinnerIcon,
  StopIcon,
  SwapIcon,
} from "./icons";

// Literal class names so Tailwind can see them. The colour never stands alone: every badge has a label and an icon.
const STYLES: Record<RunStatus, { classes: string; icon: ReactNode }> = {
  queued: { classes: "bg-st-queued-bg text-st-queued-fg", icon: <ClockIcon /> },
  running: { classes: "bg-st-running-bg text-st-running-fg", icon: <SpinnerIcon /> },
  completed: { classes: "bg-st-completed-bg text-st-completed-fg", icon: <CheckIcon /> },
  partial: { classes: "bg-st-partial-bg text-st-partial-fg", icon: <AlertIcon /> },
  failed: { classes: "bg-st-failed-bg text-st-failed-fg", icon: <CrossIcon /> },
  skipped: { classes: "bg-st-skipped-bg text-st-skipped-fg", icon: <SkipIcon /> },
  superseded: { classes: "bg-st-superseded-bg text-st-superseded-fg", icon: <SwapIcon /> },
  cancelled: { classes: "bg-st-cancelled-bg text-st-cancelled-fg", icon: <StopIcon /> },
};

export function StatusBadge({ status }: { status: RunStatus }) {
  const { classes, icon } = STYLES[status];
  return (
    <span
      data-status={status}
      className={`inline-flex items-center gap-1 rounded-full border border-current/20 px-2 py-0.5 text-xs font-semibold whitespace-nowrap ${classes}`}
    >
      {icon}
      {STATUS_LABELS[status]}
    </span>
  );
}
