import type { RunStatus } from "@ai-pr-review/shared";

/**
 * Run lifecycle (docs/scope.md §5.1):
 *
 *   queued ──► running ──► completed | partial | failed | skipped
 *   queued | running ──► superseded | cancelled
 *
 * Every other status is terminal. `skipped` is also the creation state of a run that a guard
 * stopped before it was ever queued (design §7); that is not a transition.
 */
export const ALLOWED_TRANSITIONS: Readonly<Record<RunStatus, readonly RunStatus[]>> = {
  queued: ["running", "superseded", "cancelled"],
  running: ["completed", "partial", "failed", "skipped", "superseded", "cancelled"],
  completed: [],
  partial: [],
  failed: [],
  skipped: [],
  superseded: [],
  cancelled: [],
};

export const ACTIVE_STATUSES = ["queued", "running"] as const satisfies readonly RunStatus[];

export function isActiveStatus(status: RunStatus): boolean {
  return (ACTIVE_STATUSES as readonly RunStatus[]).includes(status);
}

export function isTerminalStatus(status: RunStatus): boolean {
  return !isActiveStatus(status);
}

export function canTransition(from: RunStatus, to: RunStatus): boolean {
  return ALLOWED_TRANSITIONS[from].includes(to);
}

/** Statuses a run may currently have for a move to `to` to be legal. */
export function statusesThatCanReach(to: RunStatus): RunStatus[] {
  return (Object.keys(ALLOWED_TRANSITIONS) as RunStatus[]).filter((from) =>
    canTransition(from, to),
  );
}
