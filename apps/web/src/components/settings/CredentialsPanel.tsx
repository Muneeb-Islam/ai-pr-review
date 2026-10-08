import { PROVIDERS } from "@ai-pr-review/shared/api";
import { useState } from "react";
import {
  useCredentialActions,
  useCredentials,
  type CredentialInfo,
  type Provider,
  type SettingsScope,
} from "../../hooks/admin";
import { PROVIDER_LABELS } from "../../lib/settingsFields";
import { PROVIDER_NOTICES } from "../../lib/providers";
import { ConfirmDialog } from "../ConfirmDialog";
import { RelativeTime } from "../RelativeTime";
import { describeError, ErrorState, LoadingState } from "../States";

/**
 * Provider keys (UI-06, AC-18): write-only. A key can be set, replaced or removed, and tested with one minimal
 * provider call before it is saved; once saved the dashboard only ever shows the last four characters. For
 * people who are not admins the panel explains why it is empty instead of failing.
 */
export function CredentialsPanel({
  scope,
  canManage,
}: {
  scope: SettingsScope;
  canManage: boolean;
}) {
  const list = useCredentials(scope, canManage);
  const actions = useCredentialActions(scope);
  const [editing, setEditing] = useState<Provider | null>(null);
  const [key, setKey] = useState("");
  const [removing, setRemoving] = useState<Provider | null>(null);

  const stop = () => {
    setEditing(null);
    setKey("");
    actions.test.reset();
    actions.put.reset();
  };

  const body = () => {
    if (!canManage) {
      return (
        <p className="text-muted text-sm">
          Provider keys are managed by admins. You can see that reviews are set up, but not the
          keys, and nobody can read a key back once it is saved.
        </p>
      );
    }
    if (list.isPending) return <LoadingState label="Loading keys…" />;
    if (list.isError) return <ErrorState error={list.error} onRetry={() => void list.refetch()} />;

    const byProvider = new Map<string, CredentialInfo>(list.data.map((c) => [c.provider, c]));
    return (
      <ul className="space-y-4" aria-label="Provider keys">
        {PROVIDERS.map((provider) => {
          const credential = byProvider.get(provider);
          const notice = PROVIDER_NOTICES[provider];
          const isEditing = editing === provider;
          return (
            <li
              key={provider}
              data-provider={provider}
              className="border-border rounded border p-3"
            >
              <div className="flex flex-wrap items-center justify-between gap-2">
                <h3 className="font-semibold">{PROVIDER_LABELS[provider]}</h3>
                <p className="text-sm">
                  {credential ? (
                    <>
                      Key ending in <code>{credential.last4}</code>
                      <span className="text-muted">
                        {" "}
                        · added <RelativeTime iso={credential.created_at} />
                      </span>
                    </>
                  ) : (
                    <span className="text-muted">No key set</span>
                  )}
                </p>
              </div>
              {notice?.caution ? (
                <p className="mt-1 text-xs font-medium">{notice.caution}</p>
              ) : null}

              {isEditing ? (
                <div className="mt-3 space-y-2">
                  <label htmlFor={`key-${provider}`} className="label">
                    {credential ? "New key (replaces the saved one)" : "API key"}
                  </label>
                  <input
                    id={`key-${provider}`}
                    type="password"
                    className="field w-full max-w-md"
                    autoComplete="off"
                    spellCheck={false}
                    value={key}
                    onChange={(e) => {
                      setKey(e.target.value);
                      actions.test.reset();
                    }}
                  />
                  <p className="text-muted text-xs">
                    The key is encrypted before it is stored and cannot be shown again. Testing
                    sends one tiny request to {PROVIDER_LABELS[provider]} with it.
                  </p>
                  <div className="flex flex-wrap items-center gap-2">
                    <button
                      type="button"
                      className="btn"
                      disabled={key.trim() === "" || actions.test.isPending}
                      onClick={() => actions.test.mutate({ provider, api_key: key.trim() })}
                    >
                      {actions.test.isPending ? "Testing…" : "Test connection"}
                    </button>
                    <button
                      type="button"
                      className="btn btn-primary"
                      disabled={key.trim() === "" || actions.put.isPending}
                      onClick={() =>
                        actions.put.mutate({ provider, api_key: key.trim() }, { onSuccess: stop })
                      }
                    >
                      {actions.put.isPending ? "Saving…" : "Save key"}
                    </button>
                    <button type="button" className="btn" onClick={stop}>
                      Cancel
                    </button>
                  </div>
                  <div aria-live="polite" className="text-sm">
                    {actions.test.data ? (
                      <span
                        className={
                          actions.test.data.ok ? "font-semibold" : "text-danger font-semibold"
                        }
                      >
                        {actions.test.data.ok ? "Connected: " : "Not working: "}
                        {actions.test.data.message}
                      </span>
                    ) : null}
                  </div>
                  {actions.test.isError || actions.put.isError ? (
                    <p role="alert" className="text-danger text-sm">
                      {describeError(actions.put.error ?? actions.test.error)}
                    </p>
                  ) : null}
                </div>
              ) : (
                <div className="mt-2 flex flex-wrap gap-2">
                  <button
                    type="button"
                    className="btn"
                    onClick={() => {
                      stop();
                      setEditing(provider);
                    }}
                  >
                    {credential ? "Replace key" : "Add key"}
                  </button>
                  {credential ? (
                    <button
                      type="button"
                      className="btn btn-danger"
                      onClick={() => setRemoving(provider)}
                    >
                      Remove key
                    </button>
                  ) : null}
                </div>
              )}
            </li>
          );
        })}
      </ul>
    );
  };

  return (
    <section aria-labelledby="credentials-title" className="card space-y-3 p-4">
      <div>
        <h2 id="credentials-title" className="text-base font-semibold">
          Provider keys
        </h2>
        <p className="text-muted text-xs">
          {scope.kind === "repo"
            ? "A key set here is used for this repository. Without one, the installation's key for the same provider is used."
            : "The default key for each provider, used by repositories that have no key of their own."}
        </p>
      </div>
      {body()}
      <ConfirmDialog
        open={removing !== null}
        onOpenChange={(open) => {
          if (!open) {
            setRemoving(null);
            actions.remove.reset();
          }
        }}
        title={`Remove the ${removing ? PROVIDER_LABELS[removing] : ""} key?`}
        confirmLabel="Remove key"
        destructive
        busy={actions.remove.isPending}
        error={actions.remove.isError ? describeError(actions.remove.error) : undefined}
        onConfirm={() =>
          removing && actions.remove.mutate(removing, { onSuccess: () => setRemoving(null) })
        }
      >
        <p>
          Reviews that use this key stop working until a key is set again. The key is deleted and
          cannot be recovered. The action is recorded in the audit log.
        </p>
      </ConfirmDialog>
    </section>
  );
}
