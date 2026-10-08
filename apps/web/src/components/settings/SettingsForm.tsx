import { ApiError } from "@ai-pr-review/shared/api";
import { useMemo, useRef, useState, type FormEvent } from "react";
import type { SettingsPatch } from "../../hooks/admin";
import { COMMON_PRIVACY_NOTE, PROVIDER_NOTICES } from "../../lib/providers";
import {
  FIELD_GROUPS,
  buildPatch,
  changedPaths,
  getIn,
  initialValues,
  isDirty,
  labelOf,
  validatePatch,
  type FieldDef,
  type FieldProblems,
  type FormBase,
  type FormState,
  type FormValue,
} from "../../lib/settingsFields";
import { useUnsavedChangesGuard } from "../../lib/useUnsavedChanges";
import { describeError } from "../States";

type Raw = Record<string, unknown>;

export interface SettingsFormProps {
  scope: "repo" | "installation";
  /** The dashboard layer as stored (what a reset removes). */
  config: Raw;
  /** The settings reviews run with now: where the form starts. */
  effective: Raw;
  /** Settings (dotted paths) the repository file sets; shown, not editable. */
  fileKeys: readonly string[];
  filePath: string;
  /** Repositories only: the enabled switch. */
  enabled?: boolean;
  /** Admins edit; everyone else sees the same page read-only. */
  canEdit: boolean;
  saving: boolean;
  saveError: unknown;
  saved: boolean;
  onSave: (patch: SettingsPatch) => void;
}

const ids = (path: string) => ({
  input: `setting-${path}`,
  help: `setting-${path}-help`,
  error: `setting-${path}-error`,
  note: `setting-${path}-note`,
});

/**
 * The settings editor (UI-06): every setting a person might change, in groups, with the repository file's
 * settings locked and labelled, a reset for settings that are stored here, validation by the same schema the api
 * uses, a warning before unsaved changes are lost, and read-only for people who are not admins.
 */
export function SettingsForm(props: SettingsFormProps) {
  const { scope, config, effective, fileKeys, filePath, canEdit } = props;
  const locked = useMemo(() => new Set(fileKeys), [fileKeys]);
  const base: FormBase = useMemo(
    () => ({
      values: initialValues(effective),
      stored: config,
      ...(props.enabled !== undefined ? { enabled: props.enabled } : {}),
      locked,
    }),
    [effective, config, props.enabled, locked],
  );

  const [values, setValues] = useState<Record<string, FormValue>>(base.values);
  const [resets, setResets] = useState<ReadonlySet<string>>(new Set());
  const [enabled, setEnabled] = useState<boolean | undefined>(props.enabled);
  const [problems, setProblems] = useState<FieldProblems>({ byField: {}, general: [] });
  const summaryRef = useRef<HTMLDivElement>(null);

  const state: FormState = { values, resets, ...(enabled !== undefined ? { enabled } : {}) };
  const dirty = canEdit && isDirty(base, state);
  const guard = useUnsavedChangesGuard(dirty);

  const set = (path: string, value: FormValue) => {
    setValues((current) => ({ ...current, [path]: value }));
    setProblems((current) => {
      if (!current.byField[path]) return current;
      const { [path]: _gone, ...rest } = current.byField;
      return { ...current, byField: rest };
    });
  };
  const toggleReset = (path: string) =>
    setResets((current) => {
      const next = new Set(current);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  const discard = () => {
    setValues(base.values);
    setResets(new Set());
    setEnabled(props.enabled);
    setProblems({ byField: {}, general: [] });
  };

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (!dirty) return;
    const patch = buildPatch(base, state);
    const found = validatePatch(config, patch);
    setProblems(found);
    const count = Object.values(found.byField).flat().length + found.general.length;
    if (count > 0) {
      requestAnimationFrame(() => summaryRef.current?.focus());
      return;
    }
    props.onSave({
      ...(Object.keys(patch).length > 0 ? { config: patch } : {}),
      ...(scope === "repo" && enabled !== undefined && enabled !== props.enabled
        ? { enabled }
        : {}),
    });
  };

  const fieldErrors = Object.entries(problems.byField);
  const serverProblems =
    props.saveError instanceof ApiError && props.saveError.details.length > 0
      ? props.saveError.details
      : [];

  const renderField = (field: FieldDef) => {
    const id = ids(field.path);
    const isLocked = locked.has(field.path);
    const isReset = resets.has(field.path);
    const stored = getIn(config, field.path) !== undefined;
    const disabled = !canEdit || isLocked || isReset || props.saving;
    const errors = problems.byField[field.path] ?? [];
    const value = values[field.path] ?? "";
    const describedBy = [
      field.help ? id.help : "",
      errors.length ? id.error : "",
      isLocked || isReset ? id.note : "",
    ]
      .filter(Boolean)
      .join(" ");
    const common = {
      id: id.input,
      disabled,
      "aria-describedby": describedBy || undefined,
      "aria-invalid": errors.length > 0 || undefined,
    };

    let control;
    switch (field.kind) {
      case "checkbox":
        control = (
          <input
            {...common}
            type="checkbox"
            className="h-4 w-4"
            checked={value === true}
            onChange={(e) => set(field.path, e.target.checked)}
          />
        );
        break;
      case "select":
        control = (
          <select
            {...common}
            className="field max-w-full"
            value={String(value)}
            onChange={(e) => set(field.path, e.target.value)}
          >
            {field.options!.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
        );
        break;
      case "textarea":
      case "lines":
        control = (
          <textarea
            {...common}
            className="field w-full max-w-xl font-mono"
            rows={field.kind === "lines" ? 3 : 5}
            value={String(value)}
            onChange={(e) => set(field.path, e.target.value)}
          />
        );
        break;
      case "number":
        control = (
          <input
            {...common}
            type="number"
            inputMode="decimal"
            step={field.step}
            className="field w-40"
            value={String(value)}
            onChange={(e) => set(field.path, e.target.value)}
          />
        );
        break;
      default:
        control = (
          <input
            {...common}
            type="text"
            className="field w-full max-w-xl"
            value={String(value)}
            placeholder={field.placeholder}
            autoComplete="off"
            onChange={(e) => set(field.path, e.target.value)}
          />
        );
    }

    return (
      <div key={field.path} data-field={field.path} className="space-y-1">
        {field.kind === "checkbox" ? (
          <div className="flex items-center gap-2">
            {control}
            <label htmlFor={id.input} className="text-sm font-medium">
              {field.label}
            </label>
          </div>
        ) : (
          <>
            <label htmlFor={id.input} className="label">
              {field.label}
            </label>
            {control}
          </>
        )}
        {field.help ? (
          <p id={id.help} className="text-muted text-xs">
            {field.help}
          </p>
        ) : null}
        {isLocked ? (
          <p id={id.note} className="text-xs font-medium">
            Set by <code>{filePath}</code> on the default branch. Change it there.
          </p>
        ) : null}
        {isReset ? (
          <p id={id.note} className="text-xs font-medium">
            Will go back to the inherited or default value when you save.
          </p>
        ) : null}
        {canEdit && !isLocked && (stored || isReset) ? (
          <button
            type="button"
            className="text-xs underline"
            disabled={props.saving}
            onClick={() => toggleReset(field.path)}
          >
            {isReset ? "Undo reset" : "Reset to inherited or default"}
          </button>
        ) : null}
        {errors.length > 0 ? (
          <p id={id.error} className="text-danger text-xs">
            {errors.join(" ")}
          </p>
        ) : null}
      </div>
    );
  };

  const provider = String(values["provider"] ?? "");
  const notice = PROVIDER_NOTICES[provider];

  return (
    <form onSubmit={submit} noValidate aria-label="Settings" className="space-y-5">
      {!canEdit ? (
        <p role="note" className="card border-st-partial-fg p-3 text-sm">
          You can see these settings, but only an admin can change them.{" "}
          {scope === "repo" ? "Repository" : "Organization"} admins are the people GitHub gives
          admin rights there.
        </p>
      ) : null}

      <div ref={summaryRef} tabIndex={-1} className="focus:outline-none">
        {fieldErrors.length + problems.general.length + serverProblems.length > 0 ? (
          <div role="alert" className="card border-danger p-3 text-sm">
            <p className="font-semibold">These settings cannot be saved yet:</p>
            <ul className="mt-1 list-disc pl-5">
              {fieldErrors.map(([path, list]) => (
                <li key={path}>
                  <a className="underline" href={`#${ids(path).input}`}>
                    {labelOf(path)}
                  </a>
                  : {list.join(" ")}
                </li>
              ))}
              {problems.general.map((p) => (
                <li key={p}>{p}</li>
              ))}
              {serverProblems.map((p) => (
                <li key={p}>{p}</li>
              ))}
            </ul>
          </div>
        ) : props.saveError ? (
          <div role="alert" className="card border-danger p-3 text-sm">
            {describeError(props.saveError)}
          </div>
        ) : null}
      </div>

      {scope === "repo" && enabled !== undefined ? (
        <section aria-labelledby="group-enabled" className="card space-y-2 p-4">
          <h2 id="group-enabled" className="text-base font-semibold">
            Reviews
          </h2>
          <div className="flex items-center gap-2">
            <input
              id="setting-enabled"
              type="checkbox"
              className="h-4 w-4"
              checked={enabled}
              disabled={!canEdit || props.saving}
              onChange={(e) => setEnabled(e.target.checked)}
            />
            <label htmlFor="setting-enabled" className="text-sm font-medium">
              Review pull requests of this repository
            </label>
          </div>
          <p className="text-muted text-xs">
            Turn this off to stop new reviews without losing history or settings.
          </p>
        </section>
      ) : null}

      {FIELD_GROUPS.map((group) => (
        <fieldset key={group.id} className="card min-w-0 space-y-4 p-4">
          <legend className="px-1 text-base font-semibold">{group.title}</legend>
          {group.description ? (
            <p className="text-muted -mt-2 text-xs">{group.description}</p>
          ) : null}
          {group.fields.map(renderField)}
          {group.id === "provider" ? (
            <div
              className="bg-surface-2 space-y-1 rounded p-3 text-sm"
              data-testid="provider-notice"
            >
              {notice ? (
                <>
                  <p className="font-semibold">Privacy: {notice.name}</p>
                  <p>{notice.notice}</p>
                  {notice.caution ? <p className="font-medium">{notice.caution}</p> : null}
                </>
              ) : (
                <p>
                  Choose a provider to review code. What you choose decides who receives the changed
                  code.
                </p>
              )}
              <p className="text-muted text-xs">{COMMON_PRIVACY_NOTE}</p>
            </div>
          ) : null}
        </fieldset>
      ))}

      {canEdit ? (
        <div
          className="bg-bg sticky bottom-0 flex flex-wrap items-center gap-3 border-t py-3"
          style={{ borderColor: "var(--border)" }}
        >
          <button type="submit" className="btn btn-primary" disabled={!dirty || props.saving}>
            {props.saving ? "Saving…" : "Save settings"}
          </button>
          <button type="button" className="btn" disabled={!dirty || props.saving} onClick={discard}>
            Discard changes
          </button>
          <span aria-live="polite" className="text-muted text-sm">
            {dirty
              ? `Unsaved changes (${changedPaths(base, state).length + (enabled !== props.enabled ? 1 : 0)})`
              : props.saved
                ? "Settings saved."
                : ""}
          </span>
        </div>
      ) : null}
      {guard}
    </form>
  );
}
