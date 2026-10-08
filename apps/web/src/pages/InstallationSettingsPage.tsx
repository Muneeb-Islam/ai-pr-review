import { ApiError } from "@ai-pr-review/shared/api";
import { Link, useParams } from "react-router";
import { CredentialsPanel } from "../components/settings/CredentialsPanel";
import { SettingsForm } from "../components/settings/SettingsForm";
import { EmptyState, ErrorState, LoadingState } from "../components/States";
import {
  useInstallationSettings,
  useSaveSettings,
  type InstallationSettings,
} from "../hooks/admin";
import { useMe } from "../hooks/queries";
import { formatNumber } from "../lib/format";
import { useDocumentTitle } from "../lib/useDocumentTitle";

function Usage({
  label,
  used,
  limit,
  unit,
}: {
  label: string;
  used: number;
  limit: number;
  unit: string;
}) {
  const share = limit > 0 ? Math.min(1, used / limit) : 0;
  return (
    <div>
      <div className="flex flex-wrap items-baseline justify-between gap-2 text-sm">
        <span className="font-medium">{label}</span>
        <span>
          {formatNumber(used)} of {formatNumber(limit)} {unit}
        </span>
      </div>
      <progress
        className="mt-1 h-2 w-full"
        value={used}
        max={Math.max(limit, 1)}
        aria-label={`${label}: ${Math.round(share * 100)}% of the daily limit used`}
      />
    </div>
  );
}

function QuotaPanel({ s }: { s: InstallationSettings }) {
  return (
    <section aria-labelledby="quota-title" className="card space-y-4 p-4">
      <div>
        <h2 id="quota-title" className="text-base font-semibold">
          Usage today and data retention
        </h2>
        <p className="text-muted text-xs">
          Set by the server, not editable here. Reviews stop with a recorded reason when a daily
          limit is used up; the counters start again at{" "}
          {new Date(s.usage_today.resets_at).toLocaleTimeString([], {
            hour: "2-digit",
            minute: "2-digit",
          })}{" "}
          your time (00:00 UTC).
        </p>
      </div>
      <Usage
        label="Reviews today"
        used={s.usage_today.runs}
        limit={s.quotas.runs_per_day}
        unit="reviews"
      />
      <Usage
        label="Tokens today"
        used={s.usage_today.tokens}
        limit={s.quotas.tokens_per_day}
        unit="tokens"
      />
      <p className="text-sm" data-testid="retention">
        <span className="font-semibold">Retention: </span>
        finished runs, their findings and feedback are kept for {s.retention.days} days and then
        deleted. Only short evidence excerpts are stored, never diffs or source files.
      </p>
    </section>
  );
}

/** An installation's defaults (UI-06): the settings every repository inherits, usage against quotas, retention, keys. */
export function InstallationSettingsPage() {
  const { id = "" } = useParams();
  const me = useMe();
  const settings = useInstallationSettings(id);
  const save = useSaveSettings({ kind: "installation", id });
  useDocumentTitle(
    settings.data ? `${settings.data.account_login} defaults` : "Installation defaults",
  );

  const back = (
    <Link to="/account" className="text-sm">
      ← Account
    </Link>
  );
  if (settings.isPending) return <LoadingState label="Loading defaults…" />;
  if (settings.isError) {
    const notFound = settings.error instanceof ApiError && settings.error.status === 404;
    return (
      <div className="space-y-4">
        {back}
        {notFound ? (
          <EmptyState title="Installation not found">
            It may not exist, or you may not have access to it.
          </EmptyState>
        ) : (
          <ErrorState error={settings.error} onRetry={() => void settings.refetch()} />
        )}
      </div>
    );
  }
  const s = settings.data;
  const canEdit = me.data?.installations.find((i) => i.id === id)?.role === "admin";

  return (
    <div className="space-y-5">
      {back}
      <header className="space-y-1">
        <h1 className="text-xl font-semibold">{s.account_login}: installation defaults</h1>
        <p className="text-muted text-sm">
          Every repository of this installation starts from these settings and can override them on
          its own settings page.
        </p>
        {canEdit ? (
          <p className="text-sm">
            <Link to={`/installations/${id}/audit`}>Audit log</Link>
          </p>
        ) : null}
      </header>

      <QuotaPanel s={s} />

      <SettingsForm
        key={s.updated_at ?? "never"}
        scope="installation"
        config={s.config}
        effective={s.effective}
        fileKeys={[]}
        filePath=".github/ai-pr-review.yml"
        canEdit={canEdit}
        saving={save.isPending}
        saveError={save.error}
        saved={save.isSuccess}
        onSave={(patch) => save.mutate(patch)}
      />

      <CredentialsPanel scope={{ kind: "installation", id }} canManage={canEdit} />
    </div>
  );
}
