import { ConfigError } from "@ai-pr-review/shared";
import { ProviderCancelled, ReviewAborted } from "@ai-pr-review/core";

/**
 * What an exception during a run means for the run (design §13):
 *
 *  - `abort`: the run was stopped (supersede, cancel, shutdown). Not a failure.
 *  - `infrastructure`: Redis, PostgreSQL, the network or GitHub 5xx/429. Nothing is wrong with the review itself,
 *    so the run goes back to `queued` and the job is retried with backoff.
 *  - `github_missing` / `github_denied`: GitHub answered 404 or 401/403. Retrying will not help; the run fails
 *    with a message that says what to check.
 *  - `config`: the stored settings do not validate. The run fails with the list of problems.
 *  - `unexpected`: anything else. The run fails; only the error's name is logged.
 */
export type FailureKind =
  "abort" | "infrastructure" | "github_missing" | "github_denied" | "config" | "unexpected";

const NETWORK_CODES = new Set([
  "ECONNREFUSED",
  "ECONNRESET",
  "ETIMEDOUT",
  "ENOTFOUND",
  "EAI_AGAIN",
  "EPIPE",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "UND_ERR_SOCKET",
  "UND_ERR_CONNECT_TIMEOUT",
]);

const POSTGRES_TRANSIENT = /^(08|53|57|40)/; // connection, resources, operator intervention, rollback

function field(err: unknown, name: string): unknown {
  return typeof err === "object" && err !== null
    ? (err as Record<string, unknown>)[name]
    : undefined;
}

export function classifyError(err: unknown): FailureKind {
  if (err instanceof ReviewAborted || err instanceof ProviderCancelled) return "abort";
  const name = field(err, "name");
  if (name === "AbortError" || name === "ReviewAborted") return "abort";
  if (err instanceof ConfigError) return "config";

  const status = field(err, "status");
  if (typeof status === "number") {
    if (status === 404 || status === 410) return "github_missing";
    if (status === 401 || status === 403) return "github_denied";
    if (status >= 500 || status === 429 || status === 408) return "infrastructure";
  }

  const code = field(err, "code");
  if (typeof code === "string") {
    if (NETWORK_CODES.has(code) || POSTGRES_TRANSIENT.test(code)) return "infrastructure";
  }
  // The cause of a failed fetch carries the system error code.
  const cause = field(err, "cause");
  if (cause && cause !== err && classifyError(cause) === "infrastructure") return "infrastructure";

  const message = field(err, "message");
  if (
    typeof message === "string" &&
    /connection terminated|timeout exceeded when trying to connect|too many clients|connection is closed|fetch failed/i.test(
      message,
    )
  ) {
    return "infrastructure";
  }
  return "unexpected";
}

/** The error's class name, the only part of an error that is safe to log (messages can quote data). */
export function errorName(err: unknown): string {
  return err instanceof Error ? err.name : "unknown";
}

/** Marks an exception that BullMQ should retry with backoff. */
export class InfrastructureError extends Error {
  constructor(readonly original: unknown) {
    super("An infrastructure dependency failed.");
    this.name = "InfrastructureError";
  }
}
