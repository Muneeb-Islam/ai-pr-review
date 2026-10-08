import { parse as parseYaml, YAMLParseError } from "yaml";
import { REPO_CONFIG_PATH } from "../constants";
import {
  configSchema,
  limitsSchema,
  PROVIDERS,
  repoConfigSchema,
  SENSITIVE_CONFIG_KEYS,
  type Limits,
  type RepoConfig,
  type ResolvedConfig,
} from "./schema";
import { formatIssues } from "./validate";

export { configLeafPaths, formatIssues, validateDashboardConfig } from "./validate";

export class ConfigError extends Error {
  constructor(
    message: string,
    readonly problems: string[] = [],
  ) {
    super(message);
    this.name = "ConfigError";
  }
}

export type RawConfig = Record<string, unknown>;

function isPlainObject(value: unknown): value is RawConfig {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Parses the text of `.github/ai-pr-review.yml` (empty file = no settings). */
export function parseConfigYaml(text: string, source: string = REPO_CONFIG_PATH): RawConfig {
  let doc: unknown;
  try {
    doc = parseYaml(text);
  } catch (err) {
    const detail = err instanceof YAMLParseError ? err.message : String(err);
    throw new ConfigError(`Invalid YAML in ${source}: ${detail}`);
  }
  if (doc === null || doc === undefined) return {};
  if (!isPlainObject(doc)) {
    throw new ConfigError(`${source} must contain a YAML mapping at the top level.`);
  }
  return doc;
}

/** Per-key merge: `over` wins, nested mappings merge, arrays and scalars are replaced. */
function deepMerge(base: RawConfig, over: RawConfig): RawConfig {
  const out: RawConfig = { ...base };
  for (const [key, value] of Object.entries(over)) {
    const existing = out[key];
    out[key] = isPlainObject(existing) && isPlainObject(value) ? deepMerge(existing, value) : value;
  }
  return out;
}

/**
 * Merges dashboard layers, lowest priority first (installation defaults, then the repository's settings), the
 * way `resolveEffectiveSettings` does, but returns the raw merged layer: the input of `collectContext`, which
 * adds the repository file and validates the result.
 */
export function mergeDashboardLayers(...layers: RawConfig[]): RawConfig {
  return layers.reduce<RawConfig>((acc, layer) => deepMerge(acc, dropNulls(layer)), {});
}

/** `base_url:` with no value parses as null; treat a null as unset. */
function dropNulls(raw: RawConfig): RawConfig {
  const out: RawConfig = {};
  for (const [key, value] of Object.entries(raw)) if (value !== null) out[key] = value;
  return out;
}

/** Validates and applies defaults to an already-merged raw config. */
export function resolveConfig(raw: RawConfig): ResolvedConfig {
  const result = configSchema.safeParse(raw);
  if (result.success) return result.data;
  const problems = formatIssues(result.error.issues, raw);
  throw new ConfigError(
    `Invalid configuration:\n${problems.map((p) => `  - ${p}`).join("\n")}`,
    problems,
  );
}

/**
 * Effective config: defaults < dashboard settings < repo file (design §6).
 * The repo file may only set non-sensitive keys; `provider`, `model`, `base_url`
 * and `limits` are dashboard-only and are rejected by name.
 */
export function mergeConfig(dashboard: RawConfig, repoFile: RawConfig = {}): ResolvedConfig {
  const forbidden = SENSITIVE_CONFIG_KEYS.filter((key) => key in repoFile);
  if (forbidden.length > 0) {
    const problems = forbidden.map(
      (key) => `${key}: dashboard-only setting; not allowed in ${REPO_CONFIG_PATH}`,
    );
    throw new ConfigError(
      `Invalid repository config:\n${problems.map((p) => `  - ${p}`).join("\n")}`,
      problems,
    );
  }
  return resolveConfig(deepMerge(dropNulls(dashboard), dropNulls(repoFile)));
}

/**
 * Resolves only the non-sensitive keys of a dashboard config (review, agents, coverage, fork_prs, ignore,
 * secret_paths, instructions) with defaults applied. For code that needs routing or review settings but not
 * a provider (webhook guards). Dashboard-only keys in `dashboard` are ignored here; `resolveConfig` and
 * `mergeConfig` validate those. Throws `ConfigError` on invalid values.
 */
export function resolveRepoConfig(dashboard: RawConfig = {}): RepoConfig {
  const raw: RawConfig = {};
  for (const key of Object.keys(repoConfigSchema.shape)) {
    if (key in dashboard) raw[key] = dashboard[key];
  }
  const result = repoConfigSchema.safeParse(dropNulls(raw));
  if (result.success) return result.data;
  const problems = formatIssues(result.error.issues, raw);
  throw new ConfigError(
    `Invalid configuration:\n${problems.map((p) => `  - ${p}`).join("\n")}`,
    problems,
  );
}

/**
 * Applies a settings PATCH to the stored dashboard layer: mappings merge key by key, arrays and scalars are
 * replaced, and `null` removes a key (back to the inherited or default value). Empty mappings disappear.
 */
export function applyConfigPatch(stored: RawConfig, patch: RawConfig): RawConfig {
  const out: RawConfig = { ...stored };
  for (const [key, value] of Object.entries(patch)) {
    if (value === null) {
      delete out[key];
    } else if (isPlainObject(value)) {
      const existing = out[key];
      const merged = applyConfigPatch(isPlainObject(existing) ? existing : {}, value);
      if (Object.keys(merged).length === 0) delete out[key];
      else out[key] = merged;
    } else {
      out[key] = value;
    }
  }
  return out;
}

/** The configuration a repository would run with, as the settings API reports it (provider and model may be unset). */
export interface EffectiveSettings extends RepoConfig {
  provider: (typeof PROVIDERS)[number] | null;
  model: string | null;
  base_url: string | null;
  limits: Limits;
}

/**
 * Effective settings from layers ordered lowest to highest priority (installation defaults, then the
 * repository's dashboard settings; the repo file is merged per run by `collectContext`, not here). Built-in defaults fill the rest.
 * Throws `ConfigError` if the layers are invalid.
 */
export function resolveEffectiveSettings(...layers: RawConfig[]): EffectiveSettings {
  const merged = layers.reduce<RawConfig>((acc, layer) => deepMerge(acc, dropNulls(layer)), {});
  const repoPart = resolveRepoConfig(merged);
  const limits = limitsSchema.safeParse(merged["limits"] ?? {});
  const provider = PROVIDERS.find((p) => p === merged["provider"]) ?? null;
  const model =
    typeof merged["model"] === "string" && merged["model"] !== "" ? merged["model"] : null;
  const baseUrl =
    typeof merged["base_url"] === "string" && merged["base_url"] !== "" ? merged["base_url"] : null;
  if (!limits.success) {
    const problems = formatIssues(limits.error.issues, merged["limits"]).map((p) => `limits.${p}`);
    throw new ConfigError(
      `Invalid configuration:\n${problems.map((p) => `  - ${p}`).join("\n")}`,
      problems,
    );
  }
  return { ...repoPart, provider, model, base_url: baseUrl, limits: limits.data };
}
