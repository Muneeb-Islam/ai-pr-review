import { useState } from "react";
import { useNavigate } from "react-router";
import { useCancel, useRerun } from "../hooks/insights";
import type { RunDetail } from "../hooks/queries";
import { isActive } from "../lib/format";
import { ConfirmDialog } from "./ConfirmDialog";
import { describeError } from "./States";

/**
 * Re-run and cancel (UI-08, AC-21), with a confirmation each. A re-run queues a new run for the pull request's
 * current commit and opens it, where its progress shows live. Both are for repository admins: everyone else sees
 * the buttons disabled and why, instead of buttons that fail.
 */
export function RunActions({ run, isAdmin }: { run: RunDetail; isAdmin: boolean }) {
  const navigate = useNavigate();
  const rerun = useRerun(run.id);
  const cancel = useCancel(run.id);
  const [confirm, setConfirm] = useState<"rerun" | "cancel" | null>(null);
  const active = isActive(run.status);

  const close = () => {
    setConfirm(null);
    rerun.reset();
    cancel.reset();
  };

  return (
    <div className="flex flex-wrap items-center gap-2">
      <button
        type="button"
        className="btn"
        disabled={!isAdmin}
        aria-describedby={isAdmin ? undefined : "run-actions-note"}
        onClick={() => setConfirm("rerun")}
      >
        Re-run review
      </button>
      <button
        type="button"
        className="btn btn-danger"
        disabled={!isAdmin || !active}
        aria-describedby={isAdmin ? undefined : "run-actions-note"}
        onClick={() => setConfirm("cancel")}
      >
        Cancel run
      </button>
      {!isAdmin ? (
        <p id="run-actions-note" className="text-muted text-xs">
          Only repository admins can re-run or cancel a review.
        </p>
      ) : !active ? (
        <p className="text-muted text-xs">A run that has finished cannot be cancelled.</p>
      ) : null}

      <ConfirmDialog
        open={confirm === "rerun"}
        onOpenChange={(open) => !open && close()}
        title="Re-run this review?"
        confirmLabel="Re-run"
        busy={rerun.isPending}
        error={rerun.isError ? describeError(rerun.error) : undefined}
        onConfirm={() =>
          rerun.mutate(undefined, {
            onSuccess: (result) => {
              close();
              void navigate(`/runs/${result.run.id}`);
            },
          })
        }
      >
        <p>
          A new run is queued for the commit pull request #{run.pr_number} points at now, which may
          be newer than the one reviewed here. Any run of this pull request that is still in
          progress is replaced. The action is recorded in the audit log.
        </p>
      </ConfirmDialog>

      <ConfirmDialog
        open={confirm === "cancel"}
        onOpenChange={(open) => !open && close()}
        title="Cancel this run?"
        confirmLabel="Cancel run"
        cancelLabel="Keep running"
        destructive
        busy={cancel.isPending}
        error={cancel.isError ? describeError(cancel.error) : undefined}
        onConfirm={() => cancel.mutate(undefined, { onSuccess: close })}
      >
        <p>
          The review stops and its Check Run is closed as neutral. Nothing more is posted to the
          pull request by this run. The action is recorded in the audit log.
        </p>
      </ConfirmDialog>
    </div>
  );
}
