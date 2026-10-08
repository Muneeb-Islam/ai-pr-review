import { AGENT_IDS, CATEGORIES, SEVERITIES } from "@ai-pr-review/shared/api";
import { useMemo } from "react";
import { Link } from "react-router";
import { FindingCard } from "../components/FindingCard";
import { EmptyState, ErrorState, LoadingState } from "../components/States";
import { useFindingList, type FindingFilters } from "../hooks/insights";
import { useRepos } from "../hooks/queries";
import { AGENT_LABELS, CATEGORY_LABELS, FINDING_STATUS_LABELS } from "../lib/format";
import { useDebouncedParam, useUrlParams } from "../lib/useUrlParams";
import { useDocumentTitle } from "../lib/useDocumentTitle";

const STATUS_OPTIONS = ["posted", "summary_only", "suppressed", "all"] as const;

/** A date input value (`2026-10-05`) as the start or end of that day in the viewer's time zone. */
function dayBound(value: string | null, edge: "start" | "end"): string {
  if (!value || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return "";
  const date = new Date(edge === "start" ? `${value}T00:00:00` : `${value}T23:59:59.999`);
  return Number.isNaN(date.getTime()) ? "" : date.toISOString();
}

/**
 * The findings explorer (UI-05): findings across runs and repositories, filtered by repository, severity,
 * category, agent, status, file path and date. Filters live in the address; paging follows the cursor.
 */
export function FindingsPage() {
  useDocumentTitle("Findings");
  const { params, update, clear } = useUrlParams();
  const repos = useRepos();

  const get = (key: string) => params.get(key) ?? "";
  const pathParam = get("path");
  const [path, setPath] = useDebouncedParam(pathParam, (next) => update({ path: next }));

  const filters: FindingFilters = {
    repo_id: get("repo"),
    severity: get("severity"),
    category: get("category"),
    agent: get("agent"),
    status: get("status"),
    path: pathParam,
    from: dayBound(params.get("from"), "start"),
    to: dayBound(params.get("to"), "end"),
  };
  const filtered = ["repo", "severity", "category", "agent", "status", "path", "from", "to"].some(
    (key) => get(key) !== "",
  );

  const list = useFindingList(filters);
  const findings = useMemo(() => list.data?.pages.flatMap((p) => p.items) ?? [], [list.data]);

  const select = (
    id: string,
    label: string,
    key: string,
    options: ReadonlyArray<readonly [string, string]>,
    all: string,
  ) => (
    <div>
      <label htmlFor={id} className="label">
        {label}
      </label>
      <select
        id={id}
        className="field"
        value={get(key)}
        onChange={(e) => update({ [key]: e.target.value })}
      >
        <option value="">{all}</option>
        {options.map(([value, text]) => (
          <option key={value} value={value}>
            {text}
          </option>
        ))}
      </select>
    </div>
  );

  return (
    <div>
      <h1 className="text-xl font-semibold">Findings</h1>
      <p className="text-muted mt-1 text-sm">
        What the reviews reported across your pull requests. Tell us which findings helped: it shows
        in{" "}
        <Link className="underline" to="/analytics">
          Analytics
        </Link>
        .
      </p>

      <form
        aria-label="Filter findings"
        className="card mt-4 flex flex-wrap items-end gap-3 p-3"
        onSubmit={(e) => e.preventDefault()}
      >
        {select(
          "filter-repo",
          "Repository",
          "repo",
          (repos.data ?? []).map((r) => [r.id, r.full_name] as const),
          "All repositories",
        )}
        {select(
          "filter-severity",
          "Severity",
          "severity",
          SEVERITIES.map((s) => [s, s[0]!.toUpperCase() + s.slice(1)] as const),
          "Any severity",
        )}
        {select(
          "filter-category",
          "Category",
          "category",
          CATEGORIES.map((c) => [c, CATEGORY_LABELS[c] ?? c] as const),
          "Any category",
        )}
        {select(
          "filter-agent",
          "Agent",
          "agent",
          AGENT_IDS.map((a) => [a, AGENT_LABELS[a] ?? a] as const),
          "Any agent",
        )}
        {select(
          "filter-status",
          "Status",
          "status",
          STATUS_OPTIONS.map((s) => [s, FINDING_STATUS_LABELS[s] ?? s] as const),
          "Reported (posted or in the summary)",
        )}
        <div>
          <label htmlFor="filter-path" className="label">
            File path contains
          </label>
          <input
            id="filter-path"
            type="search"
            className="field w-48"
            value={path}
            placeholder="src/auth"
            autoComplete="off"
            onChange={(e) => setPath(e.target.value)}
          />
        </div>
        <div>
          <label htmlFor="filter-from" className="label">
            From
          </label>
          <input
            id="filter-from"
            type="date"
            className="field"
            value={get("from")}
            max={get("to") || undefined}
            onChange={(e) => update({ from: e.target.value })}
          />
        </div>
        <div>
          <label htmlFor="filter-to" className="label">
            To
          </label>
          <input
            id="filter-to"
            type="date"
            className="field"
            value={get("to")}
            min={get("from") || undefined}
            onChange={(e) => update({ to: e.target.value })}
          />
        </div>
        {filtered ? (
          <button type="button" className="btn" onClick={clear}>
            Clear filters
          </button>
        ) : null}
      </form>

      <div className="mt-4">
        {list.isPending ? (
          <LoadingState label="Loading findings…" />
        ) : list.isError ? (
          <ErrorState error={list.error} onRetry={() => void list.refetch()} />
        ) : findings.length === 0 ? (
          filtered ? (
            <EmptyState
              title="No findings match these filters"
              action={
                <button type="button" className="btn" onClick={clear}>
                  Clear filters
                </button>
              }
            />
          ) : (
            <EmptyState title="No findings yet">
              Findings show up here once a review reports something. Clean pull requests leave this
              list empty, which is fine.
            </EmptyState>
          )
        ) : (
          <>
            <ul className="space-y-3" aria-label="Findings">
              {findings.map((finding) => (
                <FindingCard key={finding.id} finding={finding} />
              ))}
            </ul>
            {list.hasNextPage ? (
              <div className="mt-4 text-center">
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
    </div>
  );
}
