import { ApiError } from "@ai-pr-review/shared/api";
import type { ReactNode } from "react";
import { SpinnerIcon } from "./icons";

export function LoadingState({ label = "Loading…" }: { label?: string }) {
  return (
    <div role="status" className="text-muted flex items-center justify-center gap-2 p-10 text-sm">
      <SpinnerIcon className="h-4 w-4" />
      <span>{label}</span>
    </div>
  );
}

export function EmptyState({
  title,
  children,
  action,
}: {
  title: string;
  children?: ReactNode;
  action?: ReactNode;
}) {
  return (
    <div className="card flex flex-col items-center gap-2 p-10 text-center">
      <h2 className="text-base font-semibold">{title}</h2>
      {children ? <p className="text-muted max-w-prose text-sm">{children}</p> : null}
      {action ? <div className="mt-2">{action}</div> : null}
    </div>
  );
}

/** What a failed request says to a person: fixed sentences, never raw error text. */
export function describeError(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.status === 404) return "This could not be found, or you do not have access to it.";
    if (error.status === 429) return "Too many requests. Wait a moment and try again.";
    if (error.status >= 500) return "The server had a problem. Try again in a moment.";
    return error.message;
  }
  return "The server could not be reached. Check your connection and try again.";
}

export function ErrorState({
  error,
  onRetry,
  title = "Something went wrong",
}: {
  error: unknown;
  onRetry?: () => void;
  title?: string;
}) {
  const requestId = error instanceof ApiError ? error.requestId : undefined;
  return (
    <div role="alert" className="card border-danger flex flex-col items-start gap-2 p-6">
      <h2 className="text-danger text-base font-semibold">{title}</h2>
      <p className="text-sm">{describeError(error)}</p>
      {requestId ? <p className="text-muted text-xs">Request id: {requestId}</p> : null}
      {onRetry ? (
        <button type="button" className="btn mt-1" onClick={onRetry}>
          Try again
        </button>
      ) : null}
    </div>
  );
}
