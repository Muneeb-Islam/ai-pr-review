import { useState } from "react";
import { Link } from "react-router";
import { GlobeIcon, LockIcon } from "../components/icons";
import { RelativeTime } from "../components/RelativeTime";
import { EmptyState, ErrorState, LoadingState } from "../components/States";
import { StatusBadge } from "../components/StatusBadge";
import { useRepos, type Repo } from "../hooks/queries";
import { useDocumentTitle } from "../lib/useDocumentTitle";

function RepoRow({ repo }: { repo: Repo }) {
  const run = repo.last_run;
  return (
    <li className="card flex flex-wrap items-center gap-x-6 gap-y-2 p-4">
      <div className="min-w-0 flex-1 basis-56">
        <Link
          to={`/runs?repo=${encodeURIComponent(repo.id)}`}
          className="font-semibold break-all"
          aria-label={`${repo.full_name}: view runs`}
        >
          {repo.full_name}
        </Link>
        <span id={`repo-${repo.id}`} className="sr-only">
          {repo.full_name}
        </span>
        <div className="text-muted mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs">
          <span className="inline-flex items-center gap-1">
            {repo.is_private ? <LockIcon /> : <GlobeIcon />}
            {repo.is_private ? "Private" : "Public"}
          </span>
          <span>Default branch: {repo.default_branch}</span>
        </div>
      </div>
      <div className="flex flex-wrap gap-x-4 text-sm">
        <Link to={`/repos/${repo.id}/settings`} aria-describedby={`repo-${repo.id}`}>
          Settings
        </Link>
        <Link
          to={`/findings?repo=${encodeURIComponent(repo.id)}`}
          aria-describedby={`repo-${repo.id}`}
        >
          Findings
        </Link>
      </div>
      <div className="text-sm">
        <span className="sr-only">Reviews: </span>
        {repo.enabled ? (
          <span className="font-medium">Enabled</span>
        ) : (
          <span className="text-muted font-medium">Disabled</span>
        )}
      </div>
      <div className="min-w-48 text-sm">
        {run ? (
          <div className="flex flex-wrap items-center gap-2">
            <StatusBadge status={run.status} />
            <span className="text-muted">
              #{run.pr_number} · <RelativeTime iso={run.finished_at ?? run.queued_at} />
            </span>
          </div>
        ) : (
          <span className="text-muted">No runs yet</span>
        )}
      </div>
    </li>
  );
}

export function ReposPage() {
  useDocumentTitle("Repositories");
  const repos = useRepos();
  const [search, setSearch] = useState("");

  const visible = (repos.data ?? []).filter((r) =>
    r.full_name.toLowerCase().includes(search.trim().toLowerCase()),
  );

  return (
    <div>
      <div className="flex flex-wrap items-end justify-between gap-3">
        <h1 className="text-xl font-semibold">Repositories</h1>
        {repos.data && repos.data.length > 0 ? (
          <div>
            <label htmlFor="repo-search" className="label">
              Search repositories
            </label>
            <input
              id="repo-search"
              type="search"
              className="field w-64 max-w-full"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
          </div>
        ) : null}
      </div>

      <div className="mt-4">
        {repos.isPending ? (
          <LoadingState label="Loading repositories…" />
        ) : repos.isError ? (
          <ErrorState error={repos.error} onRetry={() => void repos.refetch()} />
        ) : repos.data.length === 0 ? (
          <EmptyState title="No repositories yet">
            The app is installed, but none of its repositories are visible to you yet. Repositories
            appear after GitHub tells us about them; if you just added one, sign out and in again.
          </EmptyState>
        ) : visible.length === 0 ? (
          <EmptyState title="No repository matches your search" />
        ) : (
          <ul className="space-y-3" aria-label="Repositories">
            {visible.map((repo) => (
              <RepoRow key={repo.id} repo={repo} />
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
