import { useEffect, useState } from "react";
import { Link } from "react-router";
import { ConfirmDialog } from "../components/ConfirmDialog";
import { RelativeTime } from "../components/RelativeTime";
import { describeError, EmptyState, ErrorState, LoadingState } from "../components/States";
import {
  usePlatformAi,
  usePlatformAiActions,
  type PlatformAi,
  type Provider,
} from "../hooks/admin";
import { useMe } from "../hooks/queries";
import { PROVIDER_NOTICES } from "../lib/providers";
import { PROVIDER_LABELS } from "../lib/settingsFields";
import { useDocumentTitle } from "../lib/useDocumentTitle";

type ProviderRow = PlatformAi["providers"][number];

function ProviderCard({
  row,
  active,
  actions,
  onRemove,
}: {
  row: ProviderRow;
  active: boolean;
  actions: ReturnType<typeof usePlatformAiActions>;
  onRemove: () => void;
}) {
  const provider = row.provider as Provider;
  const [model, setModel] = useState(row.model ?? "");
  const [editingKey, setEditingKey] = useState(false);
  const [key, setKey] = useState("");
  useEffect(() => setModel(row.model ?? ""), [row.model]);
  const notice = PROVIDER_NOTICES[provider];
  const hasKey = row.last4 !== null;
  const modelChanged = model.trim() !== (row.model ?? "");
  const error = actions.patch.error ?? actions.saveKey.error;

  const closeKeyEditor = () => {
    setKey("");
    setEditingKey(false);
    actions.saveKey.reset();
  };

  return (
    <li data-provider={provider} className={`card space-y-3 p-4 ${active ? "ring-2" : ""}`}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-base font-semibold">
          {PROVIDER_LABELS[provider]}
          {active ? <span className="ml-2 text-xs font-medium">Active</span> : null}
        </h2>
        <p className="text-sm">
          {hasKey ? (
            <>
              Key ending in <code>{row.last4}</code>
              {row.key_added_at ? (
                <span className="text-muted">
                  {" "}
                  · added <RelativeTime iso={row.key_added_at} />
                </span>
              ) : null}
            </>
          ) : (
            <span className="text-muted">No key set</span>
          )}
        </p>
      </div>
      {notice?.caution ? <p className="text-xs font-medium">{notice.caution}</p> : null}

      {editingKey ? (
        <div className="space-y-2">
          <label htmlFor={`key-${provider}`} className="label">
            {hasKey ? "New key (replaces the saved one)" : "API key"}
          </label>
          <input
            id={`key-${provider}`}
            type="password"
            className="field w-full max-w-md"
            autoComplete="off"
            spellCheck={false}
            value={key}
            onChange={(e) => setKey(e.target.value)}
          />
          <p className="text-muted text-xs">
            The key is encrypted before it is stored and cannot be shown again.
          </p>
          <div className="flex gap-2">
            <button
              type="button"
              className="btn btn-primary"
              disabled={key.trim() === "" || actions.saveKey.isPending}
              onClick={() =>
                actions.saveKey.mutate(
                  { provider, api_key: key.trim() },
                  { onSuccess: closeKeyEditor },
                )
              }
            >
              {actions.saveKey.isPending ? "Saving…" : "Save key"}
            </button>
            <button type="button" className="btn" onClick={closeKeyEditor}>
              Cancel
            </button>
          </div>
        </div>
      ) : (
        <div className="flex flex-wrap gap-2">
          <button type="button" className="btn" onClick={() => setEditingKey(true)}>
            {hasKey ? "Replace key" : "Add key"}
          </button>
          {hasKey ? (
            <button type="button" className="btn btn-danger" onClick={onRemove}>
              Remove key
            </button>
          ) : null}
        </div>
      )}

      <div>
        <label htmlFor={`model-${provider}`} className="label">
          Model
        </label>
        <div className="flex flex-wrap gap-2">
          <input
            id={`model-${provider}`}
            className="field w-full max-w-md"
            placeholder="the provider's exact model name"
            spellCheck={false}
            value={model}
            onChange={(e) => setModel(e.target.value)}
          />
          <button
            type="button"
            className="btn"
            disabled={!modelChanged || actions.patch.isPending}
            onClick={() => actions.patch.mutate({ models: { [provider]: model.trim() } })}
          >
            Save model
          </button>
        </div>
      </div>

      <div>
        {active ? (
          <button
            type="button"
            className="btn"
            disabled={actions.patch.isPending}
            onClick={() => actions.patch.mutate({ active_provider: null })}
          >
            Deactivate
          </button>
        ) : (
          <button
            type="button"
            className="btn btn-primary"
            disabled={!hasKey || !row.model || actions.patch.isPending}
            onClick={() => actions.patch.mutate({ active_provider: provider })}
          >
            Make active
          </button>
        )}
        {!active && (!hasKey || !row.model) ? (
          <span className="text-muted ml-2 text-xs">Needs a saved key and a saved model.</span>
        ) : null}
      </div>
      {error ? (
        <p role="alert" className="text-danger text-sm">
          {describeError(error)}
        </p>
      ) : null}
    </li>
  );
}

/**
 * The platform-wide AI setting: a key and a model for Anthropic, OpenAI and DeepSeek, and which one is active.
 * Repositories and installations that choose nothing of their own use the active one. Keys are write-only:
 * once saved, only the last four characters are shown. Platform administrators only (`PLATFORM_ADMINS`).
 */
export function PlatformAiPage() {
  useDocumentTitle("Global AI setting");
  const me = useMe();
  const isAdmin = me.data?.platform_admin === true;
  const platform = usePlatformAi(isAdmin);
  const actions = usePlatformAiActions();
  const [removing, setRemoving] = useState<Provider | null>(null);

  if (me.isPending) return <LoadingState label="Loading…" />;
  if (!isAdmin) {
    return (
      <EmptyState title="Platform administrators only">
        Your GitHub login is not in the server's <code>PLATFORM_ADMINS</code> list, so you cannot
        change the global AI setting. <Link to="/repos">Back to repositories</Link>
      </EmptyState>
    );
  }
  if (platform.isPending) return <LoadingState label="Loading the AI setting…" />;
  if (platform.isError) {
    return <ErrorState error={platform.error} onRetry={() => void platform.refetch()} />;
  }

  const activeLabel = platform.data.active_provider
    ? PROVIDER_LABELS[platform.data.active_provider]
    : null;
  return (
    <div className="space-y-5">
      <header className="space-y-1">
        <h1 className="text-xl font-semibold">Global AI setting</h1>
        <p className="text-muted text-sm">
          Add a key and a model for each provider, then make one of them active. Every repository
          that has not chosen its own provider and model uses the active one. A provider, model or
          key set on a repository or installation still takes priority.
        </p>
        <p className="text-sm" aria-live="polite">
          {activeLabel ? (
            <>
              Active now: <strong>{activeLabel}</strong>
            </>
          ) : (
            "No provider is active: repositories without their own settings cannot be reviewed."
          )}
        </p>
      </header>
      <ul className="space-y-4" aria-label="Providers">
        {platform.data.providers.map((row) => (
          <ProviderCard
            key={row.provider}
            row={row}
            active={platform.data.active_provider === row.provider}
            actions={actions}
            onRemove={() => setRemoving(row.provider as Provider)}
          />
        ))}
      </ul>
      <ConfirmDialog
        open={removing !== null}
        onOpenChange={(open) => {
          if (!open) {
            setRemoving(null);
            actions.removeKey.reset();
          }
        }}
        title={`Remove the ${removing ? PROVIDER_LABELS[removing] : ""} key?`}
        confirmLabel="Remove key"
        destructive
        busy={actions.removeKey.isPending}
        error={actions.removeKey.isError ? describeError(actions.removeKey.error) : undefined}
        onConfirm={() =>
          removing && actions.removeKey.mutate(removing, { onSuccess: () => setRemoving(null) })
        }
      >
        <p>
          The key is deleted and cannot be recovered. If this provider is active, no provider will
          be active afterwards.
        </p>
      </ConfirmDialog>
    </div>
  );
}
