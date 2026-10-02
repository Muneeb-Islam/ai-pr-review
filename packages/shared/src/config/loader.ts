import { parse as parseYaml, YAMLParseError } from "yaml";
import type { z } from "zod";
import { REPO_CONFIG_PATH } from "../constants";
import {
  configSchema,
  repoConfigSchema,
  SENSITIVE_CONFIG_KEYS,
  type RepoConfig,
  type ResolvedConfig,
} from "./schema";

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

/** `base_url:` with no value parses as null; treat a null as unset. */
function dropNulls(raw: RawConfig): RawConfig {
  const out: RawConfig = {};
  for (const [key, value] of Object.entries(raw)) if (value !== null) out[key] = value;
  return out;
}

function valueAt(raw: unknown, path: PropertyKey[]): unknown {
  let cur: unknown = raw;
  for (const key of path) {
    if (typeof cur !== "object" || cur === null) return undefined;
    cur = (cur as Record<PropertyKey, unknown>)[key];
  }
  return cur;
}

export function formatIssues(issues: z.core.$ZodIssue[], raw: unknown): string[] {
  const out: string[] = [];
  for (const issue of issues) {
    const base = issue.path.map(String);
    if (issue.code === "unrecognized_keys") {
      for (const key of issue.keys) {
        out.push(`${[...base, key].join(".")}: unknown key`);
      }
      continue;
    }
    const key = base.join(".") || "(root)";
    const isMissing = valueAt(raw, issue.path) === undefined;
    out.push(isMissing ? `${key}: required` : `${key}: ${issue.message}`);
  }
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
