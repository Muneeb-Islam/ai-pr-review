import { ApiError } from "@ai-pr-review/shared/api";
import { Link, useParams } from "react-router";
import { RelativeTime } from "../components/RelativeTime";
import { EmptyState, ErrorState, LoadingState } from "../components/States";
import { useAuditList, type AuditEntry } from "../hooks/admin";
import { useMe } from "../hooks/queries";
import { AUDIT_ACTION_LABELS, formatExact } from "../lib/format";
import { useDocumentTitle } from "../lib/useDocumentTitle";
import { useUrlParams } from "../lib/useUrlParams";

/** What an entry touched, as a link when there is a page for it. */
function Target({ target }: { target: string }) {
  const [kind, id] = target.split(":");
  if (kind === "repo" && id) return <Link to={`/repos/${id}/settings`}>repository settings</Link>;
  if (kind === "run" && id) return <Link to={`/runs/${id}`}>run</Link>;
  if (kind === "installation" && id)
    return <Link to={`/installations/${id}/settings`}>installation defaults</Link>;
  return <code>{target}</code>;
}

/** The names an entry carries (setting keys, a provider, a row count); never a key or a token. */
function details(entry: AuditEntry): string {
  return Object.entries(entry.metadata)
    .map(
      ([key, value]) =>
        `${key.replaceAll("_", " ")}: ${Array.isArray(value) ? value.join(", ") : String(value)}`,
    )
    .join(" · ");
}

/** The audit log (PL-15, UI-08): who changed settings or keys, re-ran, cancelled or exported, and when. Admins only. */
export function AuditPage() {
  const { id = "" } = useParams();
  useDocumentTitle("Audit log");
  const me = useMe();
  const { params, update } = useUrlParams();
  const action = params.get("action") ?? "";
  const isAdmin = me.data?.installations.find((i) => i.id === id)?.role === "admin";
  const list = useAuditList(id, action);

  const back = (
    <Link to={`/installations/${id}/settings`} className="text-sm">
      ← Installation defaults
    </Link>
  );
  const forbidden = list.error instanceof ApiError && list.error.status === 403;
  const missing = list.error instanceof ApiError && list.error.status === 404;
  if (me.data && !isAdmin && !list.isPending) {
    return (
      <div className="space-y-4">
        {back}
        <EmptyState title="Only admins can see the audit log" />
      </div>
    );
  }

  const entries = list.data?.pages.flatMap((p) => p.items) ?? [];
  return (
    <div className="space-y-4">
      {back}
      <h1 className="text-xl font-semibold">Audit log</h1>
      <p className="text-muted text-sm">
        Changes to settings and keys, re-runs, cancellations and exports, newest first. Entries are
        never edited or deleted.
      </p>

      <form
        aria-label="Filter the audit log"
        className="card flex flex-wrap items-end gap-3 p-3"
        onSubmit={(e) => e.preventDefault()}
      >
        <div>
          <label htmlFor="audit-action" className="label">
            Action
          </label>
          <select
            id="audit-action"
            className="field"
            value={action}
            onChange={(e) => update({ action: e.target.value })}
          >
            <option value="">All actions</option>
            {Object.entries(AUDIT_ACTION_LABELS).map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </select>
        </div>
      </form>

      {list.isPending ? (
        <LoadingState label="Loading the audit log…" />
      ) : forbidden || missing ? (
        <EmptyState title="Only admins can see the audit log" />
      ) : list.isError ? (
        <ErrorState error={list.error} onRetry={() => void list.refetch()} />
      ) : entries.length === 0 ? (
        <EmptyState title={action ? "No entries for this action" : "Nothing recorded yet"}>
          Changes made from the dashboard show up here.
        </EmptyState>
      ) : (
        <>
          <div className="card overflow-x-auto">
            <table className="w-full text-left text-sm">
              <caption className="sr-only">Audit log entries, newest first</caption>
              <thead className="text-muted text-xs">
                <tr>
                  <th scope="col" className="p-3 font-semibold">
                    When
                  </th>
                  <th scope="col" className="p-3 font-semibold">
                    Who
                  </th>
                  <th scope="col" className="p-3 font-semibold">
                    What
                  </th>
                  <th scope="col" className="p-3 font-semibold">
                    On
                  </th>
                  <th scope="col" className="p-3 font-semibold">
                    Details
                  </th>
                </tr>
              </thead>
              <tbody>
                {entries.map((entry) => (
                  <tr key={entry.id} className="border-border border-t align-top">
                    <td className="p-3 whitespace-nowrap">
                      <RelativeTime iso={entry.at} />
                      <span className="sr-only"> ({formatExact(entry.at)})</span>
                    </td>
                    <td className="p-3">
                      {entry.user_login ?? (
                        <span className="text-muted">an account that no longer exists</span>
                      )}
                    </td>
                    <td className="p-3">{AUDIT_ACTION_LABELS[entry.action] ?? entry.action}</td>
                    <td className="p-3">
                      <Target target={entry.target} />
                    </td>
                    <td className="text-muted p-3 text-xs">{details(entry)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {list.hasNextPage ? (
            <div className="text-center">
              <button
                type="button"
                className="btn"
                disabled={list.isFetchingNextPage}
                onClick={() => void list.fetchNextPage()}
              >
                {list.isFetchingNextPage ? "Loading…" : "Load more"}
              </button>
            </div>
          ) : null}
        </>
      )}
    </div>
  );
}
