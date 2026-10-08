import { RUN_STATUSES } from "@ai-pr-review/shared/api";
import { useEffect, useMemo, useState } from "react";
import { Link, useSearchParams } from "react-router";
import { EmptyState, ErrorState, LoadingState } from "../components/States";
import { RunRow } from "../components/RunRow";
import { useRepos, useRunList, type RunFilters, type RunSummary } from "../hooks/queries";
import { STATUS_LABELS } from "../lib/format";
import { useDocumentTitle } from "../lib/useDocumentTitle";

const PENDING = "queued,running";

/** A date input value (`2026-10-05`) as the start or end of that day in the viewer's time zone. */
function dayBound(value: string | null, edge: "start" | "end"): string {
  if (!value || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return "";
  const date = new Date(edge === "start" ? `${value}T00:00:00` : `${value}T23:59:59.999`);
  return Number.isNaN(date.getTime()) ? "" : date.toISOString();
}

function RunList({ label, runs }: { label: string; runs: RunSummary[] }) {
  return (
    <ul className="space-y-3" aria-label={label}>
      {runs.map((run) => (
        <RunRow key={run.id} run={run} />
      ))}
    </ul>
  );
}

export function RunsPage() {
  const [params, setParams] = useSearchParams();
  const view = params.get("view") === "pending" ? "pending" : "all";
  useDocumentTitle(view === "pending" ? "Pending runs" : "Runs");

  const repos = useRepos();
  const repoId = params.get("repo") ?? "";
  const status = view === "pending" ? PENDING : (params.get("status") ?? "");
  const branchParam = params.get("branch") ?? "";
  const fromParam = params.get("from") ?? "";
  const toParam = params.get("to") ?? "";

  const update = (changes: Record<string, string>) =>
    setParams(
      (previous) => {
        const next = new URLSearchParams(previous);
        for (const [key, value] of Object.entries(changes)) {
          if (value) next.set(key, value);
          else next.delete(key);
        }
        return next;
      },
      { replace: true },
    );

  // The branch is typed, so it is applied shortly after the last keystroke.
  const [branch, setBranch] = useState(branchParam);
  useEffect(() => setBranch(branchParam), [branchParam]);
  useEffect(() => {
    if (branch === branchParam) return;
    const timer = setTimeout(() => update({ branch: branch.trim() }), 300);
    return () => clearTimeout(timer);
  }, [branch, branchParam]);

  const base: RunFilters = {
    repo_id: repoId,
    branch: branchParam,
    from: dayBound(fromParam, "start"),
    to: dayBound(toParam, "end"),
  };
  const filters: RunFilters = { ...base, status };
  const filtered = Boolean(repoId || branchParam || fromParam || toParam || params.get("status"));

  // Runs in flight are pinned above the history when nothing narrows the status (UI-03).
  const showPinned = view === "all" && !status;
  const pinned = useRunList({ ...base, status: PENDING }, { limit: 50, enabled: showPinned });
  const list = useRunList(filters);

  const pinnedRuns = useMemo(
    () => (showPinned ? (pinned.data?.pages.flatMap((p) => p.items) ?? []) : []),
    [showPinned, pinned.data],
  );
  const pinnedIds = useMemo(() => new Set(pinnedRuns.map((r) => r.id)), [pinnedRuns]);
  const runs = useMemo(
    () => (list.data?.pages.flatMap((p) => p.items) ?? []).filter((r) => !pinnedIds.has(r.id)),
    [list.data, pinnedIds],
  );

  const clear = () => {
    setBranch("");
    setParams(view === "pending" ? { view: "pending" } : {}, { replace: true });
  };

  const tabClass = (current: boolean) =>
    `rounded-t px-4 py-2 text-sm font-medium no-underline border-b-2 ${
      current ? "border-accent text-fg" : "text-muted hover:text-fg border-transparent"
    }`;
  const withParams = (changes: Record<string, string>) => {
    const next = new URLSearchParams(params);
    for (const [key, value] of Object.entries(changes)) {
      if (value) next.set(key, value);
      else next.delete(key);
    }
    return `/runs?${next.toString()}`;
  };

  return (
    <div>
      <h1 className="text-xl font-semibold">{view === "pending" ? "Pending runs" : "Runs"}</h1>

      <nav aria-label="Runs view" className="border-border mt-3 flex border-b">
        <Link
          to={withParams({ view: "", status: params.get("status") ?? "" })}
          className={tabClass(view === "all")}
          aria-current={view === "all" ? "page" : undefined}
        >
          All runs
        </Link>
        <Link
          to={withParams({ view: "pending", status: "" })}
          className={tabClass(view === "pending")}
          aria-current={view === "pending" ? "page" : undefined}
        >
          Pending
        </Link>
      </nav>

      <form
        aria-label="Filter runs"
        className="card mt-4 flex flex-wrap items-end gap-3 p-3"
        onSubmit={(e) => e.preventDefault()}
      >
        <div>
          <label htmlFor="filter-repo" className="label">
            Repository
          </label>
          <select
            id="filter-repo"
            className="field w-56 max-w-full"
            value={repoId}
            onChange={(e) => update({ repo: e.target.value })}
          >
            <option value="">All repositories</option>
            {(repos.data ?? []).map((repo) => (
              <option key={repo.id} value={repo.id}>
                {repo.full_name}
              </option>
            ))}
          </select>
        </div>
        {view === "all" ? (
          <div>
            <label htmlFor="filter-status" className="label">
              Status
            </label>
            <select
              id="filter-status"
              className="field"
              value={params.get("status") ?? ""}
              onChange={(e) => update({ status: e.target.value })}
            >
              <option value="">All statuses</option>
              {RUN_STATUSES.map((s) => (
                <option key={s} value={s}>
                  {STATUS_LABELS[s]}
                </option>
              ))}
            </select>
          </div>
        ) : null}
        <div>
          <label htmlFor="filter-branch" className="label">
            Base branch
          </label>
          <input
            id="filter-branch"
            className="field w-40"
            value={branch}
            placeholder="main"
            autoComplete="off"
            onChange={(e) => setBranch(e.target.value)}
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
            value={fromParam}
            max={toParam || undefined}
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
            value={toParam}
            min={fromParam || undefined}
            onChange={(e) => update({ to: e.target.value })}
          />
        </div>
        {filtered ? (
          <button type="button" className="btn" onClick={clear}>
            Clear filters
          </button>
        ) : null}
      </form>

      <div className="mt-4 space-y-6">
        {pinnedRuns.length > 0 ? (
          <section aria-labelledby="in-progress-title">
            <h2 id="in-progress-title" className="mb-2 text-sm font-semibold">
              In progress ({pinnedRuns.length})
            </h2>
            <RunList label="Runs in progress" runs={pinnedRuns} />
          </section>
        ) : null}

        <section aria-labelledby="history-title">
          <h2
            id="history-title"
            className={pinnedRuns.length > 0 ? "mb-2 text-sm font-semibold" : "sr-only"}
          >
            {view === "pending" ? "Queued and running" : "History"}
          </h2>
          {list.isPending ? (
            <LoadingState label="Loading runs…" />
          ) : list.isError ? (
            <ErrorState error={list.error} onRetry={() => void list.refetch()} />
          ) : runs.length === 0 && pinnedRuns.length === 0 ? (
            view === "pending" ? (
              <EmptyState title="Nothing is queued or running">
                New reviews show up here the moment a pull request triggers one.
              </EmptyState>
            ) : filtered ? (
              <EmptyState
                title="No runs match these filters"
                action={
                  <button type="button" className="btn" onClick={clear}>
                    Clear filters
                  </button>
                }
              />
            ) : (
              <EmptyState title="No runs yet">
                Open or update a pull request on a repository where the app is installed and
                enabled; its review appears here.
              </EmptyState>
            )
          ) : (
            <>
              {runs.length > 0 ? <RunList label="Runs" runs={runs} /> : null}
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
        </section>
      </div>
    </div>
  );
}
