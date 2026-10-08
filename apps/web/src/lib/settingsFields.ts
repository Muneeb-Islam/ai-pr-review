// The settings form as data (UI-06): which fields exist, how a configuration becomes form values and a form
// becomes a patch, and how the shared schema's problems map back onto fields. Pure functions, no React, so the
// rules (what counts as a change, what a reset sends, which fields the repository file locks) are tested directly.
import {
  DRAFT_BEHAVIORS,
  FORK_PR_POLICIES,
  MODES,
  PROVIDERS,
  SEVERITIES,
  validateDashboardConfig,
} from "@ai-pr-review/shared/api";

export type FormValue = string | boolean;
export type FormValues = Record<string, FormValue>;

export type FieldKind = "text" | "textarea" | "lines" | "number" | "checkbox" | "select";

export interface FieldOption {
  value: string;
  label: string;
}

export interface FieldDef {
  /** Dotted path in the configuration: `review.mode`. */
  path: string;
  label: string;
  help?: string;
  kind: FieldKind;
  options?: readonly FieldOption[];
  /** For numbers: step of the input (the schema is the judge of the range). */
  step?: number;
  placeholder?: string;
  /** An optional text setting: clearing it removes the stored value instead of storing an empty string. */
  optional?: boolean;
}

export interface FieldGroup {
  id: string;
  title: string;
  description?: string;
  fields: FieldDef[];
}

const labelled = (values: readonly string[], labels: Record<string, string>): FieldOption[] =>
  values.map((value) => ({ value, label: labels[value] ?? value }));

const SEVERITY_LABELS = Object.fromEntries(
  SEVERITIES.map((s) => [s, s[0]!.toUpperCase() + s.slice(1)]),
);

export const PROVIDER_LABELS: Record<string, string> = {
  deepseek: "DeepSeek",
  anthropic: "Anthropic",
  openai: "OpenAI",
};

export const FIELD_GROUPS: FieldGroup[] = [
  {
    id: "provider",
    title: "Provider and model",
    description:
      "Where the code under review is sent. These can only be set here, never from the repository file.",
    fields: [
      {
        path: "provider",
        label: "Provider",
        kind: "select",
        options: [{ value: "", label: "Not set" }, ...labelled(PROVIDERS, PROVIDER_LABELS)],
      },
      {
        path: "model",
        label: "Model",
        kind: "text",
        optional: true,
        placeholder: "the provider's model name",
        help: "The exact model name from the provider's documentation.",
      },
      {
        path: "base_url",
        label: "Custom endpoint (optional)",
        kind: "text",
        optional: true,
        placeholder: "https://api.example.com/v1",
        help: "An OpenAI-compatible endpoint. Must be a public HTTPS address; private and local addresses are refused.",
      },
    ],
  },
  {
    id: "review",
    title: "Review",
    fields: [
      {
        path: "review.mode",
        label: "Enforcement mode",
        kind: "select",
        options: [
          { value: "comment_only", label: "Comment only (never fails the check)" },
          { value: "warn", label: "Warn (neutral check when a finding meets the thresholds)" },
          { value: "fail_on_threshold", label: "Fail on threshold (failing check)" },
        ],
        help: "A failing check blocks merging only if the repository requires this check in its branch protection.",
      },
      {
        path: "review.minimum_severity",
        label: "Minimum severity",
        kind: "select",
        options: labelled(SEVERITIES, SEVERITY_LABELS),
        help: "Findings below this severity are counted but not shown.",
      },
      {
        path: "review.minimum_confidence",
        label: "Minimum confidence (0 to 1)",
        kind: "number",
        step: 0.05,
        help: "Findings the model is less sure of than this are counted but not shown.",
      },
      {
        path: "review.target_branches",
        label: "Target branches",
        kind: "lines",
        help: "One branch per line. Only pull requests into these branches are reviewed.",
      },
      {
        path: "review.draft_behavior",
        label: "Draft pull requests",
        kind: "select",
        options: [
          { value: "summary_only", label: "Summary only (no inline comments)" },
          { value: "full", label: "Review fully" },
          { value: "skip", label: "Skip" },
        ],
      },
      {
        path: "fork_prs",
        label: "Pull requests from forks",
        kind: "select",
        options: [
          { value: "skip", label: "Skip (recommended)" },
          { value: "review", label: "Review" },
        ],
        help: "Fork pull requests come from outside the repository. They are skipped unless you choose to review them. No repository code is ever run either way.",
      },
    ],
  },
  {
    id: "agents",
    title: "Agents",
    fields: [
      { path: "agents.code_review", label: "Code Review", kind: "checkbox" },
      { path: "agents.test_coverage", label: "Test Coverage", kind: "checkbox" },
      { path: "agents.security", label: "Security", kind: "checkbox" },
      {
        path: "agents.final_review",
        label: "Final Review",
        kind: "checkbox",
        help: "A second pass that checks each finding against the diff. Slower and costs more.",
      },
    ],
  },
  {
    id: "files",
    title: "Files",
    fields: [
      {
        path: "ignore",
        label: "Ignore patterns",
        kind: "lines",
        help: "One glob per line. Matching files are not reviewed and are listed as skipped.",
      },
      {
        path: "secret_paths",
        label: "Secret paths",
        kind: "lines",
        help: "One glob per line. Matching files are never sent to a provider.",
      },
    ],
  },
  {
    id: "coverage",
    title: "Coverage report",
    fields: [
      {
        path: "coverage.artifact_name",
        label: "Artifact name",
        kind: "text",
        help: "The GitHub Actions artifact that holds the LCOV report.",
      },
      {
        path: "coverage.lcov_path",
        label: "LCOV file path",
        kind: "text",
        help: "Inside that artifact.",
      },
    ],
  },
  {
    id: "instructions",
    title: "Custom instructions",
    fields: [
      {
        path: "instructions",
        label: "Instructions for the reviewers",
        kind: "textarea",
        help: "Plain text added to the review prompts, for example conventions to enforce. Treated as guidance, not as commands.",
      },
    ],
  },
  {
    id: "limits",
    title: "Size and cost limits",
    fields: [
      {
        path: "review.max_changed_files",
        label: "Most changed files per review",
        kind: "number",
        step: 1,
      },
      {
        path: "review.max_patch_characters",
        label: "Most patch characters per review",
        kind: "number",
        step: 1,
      },
      {
        path: "review.max_inline_comments",
        label: "Most inline comments per review",
        kind: "number",
        step: 1,
      },
      { path: "limits.concurrency", label: "Model calls at once", kind: "number", step: 1 },
      {
        path: "limits.max_requests",
        label: "Most model calls per review",
        kind: "number",
        step: 1,
      },
      { path: "limits.max_total_tokens", label: "Most tokens per review", kind: "number", step: 1 },
      {
        path: "limits.request_timeout_ms",
        label: "Timeout per model call (ms)",
        kind: "number",
        step: 1000,
      },
    ],
  },
];

export const ALL_FIELDS: FieldDef[] = FIELD_GROUPS.flatMap((g) => g.fields);

// Exported so a test can check the form offers every value the schema accepts.
export const SCHEMA_ENUMS = { MODES, DRAFT_BEHAVIORS, FORK_PR_POLICIES, PROVIDERS, SEVERITIES };

// ---------- reading and writing paths ----------

type Raw = Record<string, unknown>;

export function getIn(config: unknown, path: string): unknown {
  let current: unknown = config;
  for (const key of path.split(".")) {
    if (typeof current !== "object" || current === null) return undefined;
    current = (current as Raw)[key];
  }
  return current;
}

const isObject = (value: unknown): value is Raw =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** A copy of `config` with `value` at `path` (`undefined` removes it, and empty parents with it). */
export function setIn(config: Raw, path: string, value: unknown): Raw {
  const [head, ...rest] = path.split(".") as [string, ...string[]];
  const out: Raw = { ...config };
  if (rest.length === 0) {
    if (value === undefined) delete out[head];
    else out[head] = value;
    return out;
  }
  const child = setIn(isObject(out[head]) ? (out[head] as Raw) : {}, rest.join("."), value);
  if (Object.keys(child).length === 0) delete out[head];
  else out[head] = child;
  return out;
}

// ---------- configuration <-> form values ----------

/** What a field shows for a value of the configuration. */
export function toFormValue(field: FieldDef, value: unknown): FormValue {
  switch (field.kind) {
    case "checkbox":
      return value === true;
    case "lines":
      return Array.isArray(value) ? value.join("\n") : "";
    case "number":
      return typeof value === "number" ? String(value) : "";
    default:
      return typeof value === "string" ? value : "";
  }
}

export const initialValues = (effective: unknown): FormValues =>
  Object.fromEntries(ALL_FIELDS.map((f) => [f.path, toFormValue(f, getIn(effective, f.path))]));

/** The configuration value a form value stands for; `undefined` when the field is empty. */
export function fromFormValue(field: FieldDef, value: FormValue): unknown {
  switch (field.kind) {
    case "checkbox":
      return value === true;
    case "lines": {
      const lines = String(value)
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean);
      return lines;
    }
    case "number": {
      const text = String(value).trim();
      return text === "" ? undefined : Number(text);
    }
    default: {
      const text = String(value);
      const blank = text.trim() === "";
      return blank && (field.optional || field.kind === "select") ? undefined : text;
    }
  }
}

export interface FormState {
  values: FormValues;
  /** Fields the user chose to reset to the inherited or default value. */
  resets: ReadonlySet<string>;
  enabled?: boolean;
}

export interface FormBase {
  /** What the form started from. */
  values: FormValues;
  /** The dashboard layer as stored: a reset only means something for a key that is stored. */
  stored: Raw;
  enabled?: boolean;
  /** Dotted paths the repository file sets; they are not edited here. */
  locked: ReadonlySet<string>;
}

/** The fields whose value differs from where the form started (locked fields never count as changed). */
export function changedPaths(base: FormBase, state: FormState): string[] {
  return ALL_FIELDS.filter((f) => !base.locked.has(f.path))
    .filter((f) => state.resets.has(f.path) || state.values[f.path] !== base.values[f.path])
    .map((f) => f.path);
}

export function isDirty(base: FormBase, state: FormState): boolean {
  return (
    changedPaths(base, state).length > 0 ||
    (state.enabled !== undefined && state.enabled !== base.enabled)
  );
}

/**
 * The patch the api takes (design §8): changed keys with their new value, `null` to remove a stored key. A key
 * the user cleared (an optional text, or a reset) is removed only if it is stored; otherwise nothing is sent.
 */
export function buildPatch(base: FormBase, state: FormState): Raw {
  let patch: Raw = {};
  for (const path of changedPaths(base, state)) {
    const field = ALL_FIELDS.find((f) => f.path === path)!;
    const stored = getIn(base.stored, path) !== undefined;
    const value = state.resets.has(path)
      ? undefined
      : fromFormValue(field, state.values[path] ?? "");
    if (value === undefined) {
      if (stored) patch = setIn(patch, path, null);
    } else {
      patch = setIn(patch, path, value);
    }
  }
  return patch;
}

/** The dashboard layer as it would be stored after `patch` (for checking it against the schema before sending). */
export function applyPatch(stored: Raw, patch: Raw): Raw {
  let out = stored;
  const walk = (node: Raw, prefix: string) => {
    for (const [key, value] of Object.entries(node)) {
      const path = prefix ? `${prefix}.${key}` : key;
      if (isObject(value)) walk(value, path);
      else out = setIn(out, path, value === null ? undefined : value);
    }
  };
  walk(patch, "");
  return out;
}

export interface FieldProblems {
  byField: Record<string, string[]>;
  /** Problems about something no field edits (shown together at the top). */
  general: string[];
}

/** Runs the shared schema over the config the patch would produce and files each problem under its field. */
export function validatePatch(stored: Raw, patch: Raw): FieldProblems {
  const result = validateDashboardConfig(applyPatch(stored, patch));
  const problems: FieldProblems = { byField: {}, general: [] };
  if (result.ok) return problems;
  for (const problem of result.problems) {
    const [where = "", ...message] = problem.split(": ");
    const text = message.join(": ") || problem;
    // `review.target_branches.0` belongs to `review.target_branches`.
    const field = ALL_FIELDS.find((f) => where === f.path || where.startsWith(`${f.path}.`));
    if (field) (problems.byField[field.path] ??= []).push(text);
    else problems.general.push(problem);
  }
  return problems;
}

/** A readable name for a path in a problem message. */
export const labelOf = (path: string): string =>
  ALL_FIELDS.find((f) => f.path === path)?.label ?? path;
