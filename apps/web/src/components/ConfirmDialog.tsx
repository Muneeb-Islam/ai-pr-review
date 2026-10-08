import * as AlertDialog from "@radix-ui/react-alert-dialog";
import type { ReactNode } from "react";

/**
 * A confirmation before something that changes things (re-run, cancel, delete a key, leave with unsaved changes).
 * Radix gives the dialog its focus trap, Escape to cancel and the return of focus; focus starts on the safe
 * button. The caller owns `open` and runs the action in `onConfirm` (the dialog stays open while `busy`, and
 * shows `error` if the action failed, so a failure is never silent).
 */
export function ConfirmDialog({
  open,
  onOpenChange,
  title,
  children,
  confirmLabel,
  cancelLabel = "Cancel",
  onConfirm,
  busy = false,
  error,
  destructive = false,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  children: ReactNode;
  confirmLabel: string;
  cancelLabel?: string;
  onConfirm: () => void;
  busy?: boolean;
  error?: string | undefined;
  destructive?: boolean;
}) {
  return (
    <AlertDialog.Root open={open} onOpenChange={(next) => (busy ? undefined : onOpenChange(next))}>
      <AlertDialog.Portal>
        <AlertDialog.Overlay className="fixed inset-0 z-40 bg-black/50" />
        <AlertDialog.Content className="card fixed top-1/2 left-1/2 z-50 w-[calc(100vw-2rem)] max-w-md -translate-x-1/2 -translate-y-1/2 p-5 shadow-xl">
          <AlertDialog.Title className="text-base font-semibold">{title}</AlertDialog.Title>
          <AlertDialog.Description asChild>
            <div className="text-muted mt-2 space-y-2 text-sm">{children}</div>
          </AlertDialog.Description>
          {error ? (
            <p role="alert" className="text-danger mt-3 text-sm">
              {error}
            </p>
          ) : null}
          <div className="mt-5 flex flex-wrap justify-end gap-2">
            <AlertDialog.Cancel asChild>
              <button type="button" className="btn" disabled={busy}>
                {cancelLabel}
              </button>
            </AlertDialog.Cancel>
            <button
              type="button"
              className={`btn ${destructive ? "btn-danger" : "btn-primary"}`}
              disabled={busy}
              onClick={onConfirm}
            >
              {busy ? "Working…" : confirmLabel}
            </button>
          </div>
        </AlertDialog.Content>
      </AlertDialog.Portal>
    </AlertDialog.Root>
  );
}
