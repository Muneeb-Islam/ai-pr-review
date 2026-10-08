import { useEffect } from "react";
import { useBlocker } from "react-router";
import { ConfirmDialog } from "../components/ConfirmDialog";

/**
 * Warns before unsaved changes are lost: the browser's own prompt when the tab is closed or reloaded, and a
 * confirmation in the page when a link or the back button would leave. Render the returned element anywhere in
 * the page.
 */
export function useUnsavedChangesGuard(dirty: boolean) {
  const blocker = useBlocker(dirty);

  useEffect(() => {
    if (!dirty) return;
    const warn = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      // Some browsers still need a return value to show the prompt.
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [dirty]);

  return (
    <ConfirmDialog
      open={blocker.state === "blocked"}
      onOpenChange={(open) => {
        if (!open && blocker.state === "blocked") blocker.reset();
      }}
      title="Leave without saving?"
      confirmLabel="Leave"
      cancelLabel="Stay on this page"
      destructive
      onConfirm={() => blocker.state === "blocked" && blocker.proceed()}
    >
      <p>You have changes that are not saved. If you leave now they are lost.</p>
    </ConfirmDialog>
  );
}
