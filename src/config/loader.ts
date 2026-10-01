import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { parse as parseYaml, YAMLParseError } from "yaml";
import type { z } from "zod";
import { configSchema, type ResolvedConfig } from "./schema";

export class ConfigError extends Error {
  constructor(
    message: string,
    readonly problems: string[] = [],
  ) {
    super(message);
    this.name = "ConfigError";
  }
}

/** Values from Action inputs. Empty / undefined means "not provided". */
export interface ConfigInputs {
  provider?: string;
  model?: string;
  baseUrl?: string;
  mode?: string;
}

type RawConfig = Record<string, unknown>;

function isPlainObject(value: unknown): value is RawConfig {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function parseConfigYaml(text: string, source: string): RawConfig {
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

/** Precedence: Action inputs > config file > defaults (defaults are applied by the schema). */
export function mergeInputs(file: RawConfig, inputs: ConfigInputs): RawConfig {
  const merged: RawConfig = { ...file };
  // `base_url:` with no value parses as null; treat it as unset.
  if (merged["base_url"] === null) delete merged["base_url"];

  if (inputs.provider) merged["provider"] = inputs.provider;
  if (inputs.model) merged["model"] = inputs.model;
  if (inputs.baseUrl) merged["base_url"] = inputs.baseUrl;
  if (inputs.mode) {
    const review = isPlainObject(merged["review"]) ? merged["review"] : {};
    merged["review"] = { ...review, mode: inputs.mode };
  }
  return merged;
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

export function resolveConfig(raw: RawConfig): ResolvedConfig {
  const result = configSchema.safeParse(raw);
  if (result.success) return result.data;
  const problems = formatIssues(result.error.issues, raw);
  throw new ConfigError(
    `Invalid configuration:\n${problems.map((p) => `  - ${p}`).join("\n")}`,
    problems,
  );
}

export interface LoadedConfig {
  config: ResolvedConfig;
  /** Absolute path if a file was read, otherwise undefined (defaults + inputs only). */
  filePath?: string;
}

export function loadConfig(opts: {
  workspace: string;
  configPath: string;
  inputs: ConfigInputs;
}): LoadedConfig {
  const workspace = path.resolve(opts.workspace);
  const filePath = path.resolve(workspace, opts.configPath);
  const rel = path.relative(workspace, filePath);
  if (rel.startsWith("..") || path.isAbsolute(rel)) {
    throw new ConfigError(`config_path must stay inside the workspace: ${opts.configPath}`);
  }

  let file: RawConfig = {};
  let used: string | undefined;
  if (existsSync(filePath)) {
    file = parseConfigYaml(readFileSync(filePath, "utf8"), opts.configPath);
    used = filePath;
  }
  const config = resolveConfig(mergeInputs(file, opts.inputs));
  return used ? { config, filePath: used } : { config };
}
