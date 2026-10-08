import { ApiError } from "@ai-pr-review/shared/api";
import { Link, useParams } from "react-router";
import { CredentialsPanel } from "../components/settings/CredentialsPanel";
import { ExportPanel } from "../components/settings/ExportPanel";
import { SettingsForm } from "../components/settings/SettingsForm";
import { EmptyState, ErrorState, LoadingState } from "../components/States";
import { useRepoSettings, useSaveSettings } from "../hooks/admin";
import { useRepo } from "../hooks/queries";
import { useDocumentTitle } from "../lib/useDocumentTitle";

const FILE_STATUS_TEXT = {
  applied: "The repository file is read and its settings below are locked.",
  absent: "The repository has no settings file; everything here is set in the dashboard.",
  invalid: "The repository file cannot be used, so it is ignored and the dashboard settings apply.",
  unavailable: "GitHub could not be asked for the repository file just now.",
} as const;

/**
 * One repository's settings (UI-06): the editor, the repository file's part in it, provider keys and export.
 * Admins edit; everyone else with access to the repository sees the same page read-only.
 */
export function RepoSettingsPage() {
  const { id = "" } = useParams();
  const repo = useRepo(id);
  const settings = useRepoSettings(id);
  const save = useSaveSettings({ kind: "repo", id });
  useDocumentTitle(repo.data ? `${repo.data.full_name} settings` : "Repository settings");

  const back = (
    <Link to="/repos" className="text-sm">
      ← Repositories
    </Link>
  );
  const failure = repo.error ?? settings.error;
  if (repo.isPending || settings.isPending) {
    if (!failure) return <LoadingState label="Loading settings…" />;
  }
  if (failure) {
    const notFound = failure instanceof ApiError && failure.status === 404;
    return (
      <div className="space-y-4">
        {back}
        {notFound ? (
          <EmptyState title="Repository not found">
            It may not exist, or you may not have access to it.
          </EmptyState>
        ) : (
          <ErrorState
            error={failure}
            onRetry={() => {
              void repo.refetch();
              void settings.refetch();
            }}
          />
        )}
      </div>
    );
  }
  if (!repo.data || !settings.data) return null;

  const r = repo.data;
  const s = settings.data;
  const canEdit = r.role === "admin";
  return (
    <div className="space-y-5">
      {back}
      <header className="space-y-1">
        <h1 className="text-xl font-semibold break-all">{r.full_name} settings</h1>
        <p className="flex flex-wrap gap-x-4 text-sm">
          <Link to={`/runs?repo=${encodeURIComponent(r.id)}`}>Runs</Link>
          <Link to={`/findings?repo=${encodeURIComponent(r.id)}`}>Findings</Link>
          <Link to={`/analytics?repo=${encodeURIComponent(r.id)}`}>Analytics</Link>
        </p>
      </header>

      <section aria-labelledby="precedence-title" className="card space-y-2 p-4 text-sm">
        <h2 id="precedence-title" className="text-base font-semibold">
          Where settings come from
        </h2>
        <p className="text-muted">
          Built-in defaults, then the installation&apos;s defaults, then the settings on this page,
          then <code>{s.repo_file.path}</code> in the repository, which wins for the settings it
          sets. Provider, model, endpoint and limits can only be set here.
        </p>
        <p data-testid="repo-file-status" data-status={s.repo_file.status}>
          <span className="font-semibold">Repository file: </span>
          {FILE_STATUS_TEXT[s.repo_file.status]}
          {s.repo_file.message && s.repo_file.status !== "unavailable" ? (
            <span className="text-muted"> {s.repo_file.message}</span>
          ) : null}
        </p>
        {s.repo_file_keys.length > 0 ? (
          <p className="text-muted text-xs">Set by the file: {s.repo_file_keys.join(", ")}.</p>
        ) : null}
      </section>

      <SettingsForm
        // Start again from the saved values after every save.
        key={`${s.updated_at ?? "never"}|${s.enabled}|${s.repo_file_keys.join(",")}`}
        scope="repo"
        config={s.config}
        effective={s.effective}
        fileKeys={s.repo_file_keys}
        filePath={s.repo_file.path}
        enabled={s.enabled}
        canEdit={canEdit}
        saving={save.isPending}
        saveError={save.error}
        saved={save.isSuccess}
        onSave={(patch) => save.mutate(patch)}
      />

      <CredentialsPanel scope={{ kind: "repo", id }} canManage={canEdit} />
      {canEdit ? <ExportPanel repoId={id} /> : null}
    </div>
  );
}
