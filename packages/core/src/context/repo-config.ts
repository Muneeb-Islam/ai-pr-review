import {
  ConfigError,
  configSchema,
  formatIssues,
  mergeConfig,
  parseConfigYaml,
  REPO_CONFIG_PATH,
  SENSITIVE_CONFIG_KEYS,
  type RawConfig,
  type ResolvedConfig,
} from "@ai-pr-review/shared";
import type { RepoRef } from "../github/client";
import {
  call,
  contentSchema,
  decodeContent,
  isNotFound,
  repoParams,
  type ContextClient,
} from "./github";

/** A config file is a few lines; refuse anything large rather than parse attacker-sized YAML. */
const MAX_CONFIG_BYTES = 64 * 1024;

export interface RepoConfigOptions {
  client: ContextClient;
  repo: RepoRef;
  /** The base branch commit. The file is read at this SHA and never from the PR head. */
  baseSha: string;
  /** Installation defaults merged with the repository's dashboard settings. */
  dashboard: RawConfig;
  signal?: AbortSignal | undefined;
}

export interface RepoConfigResult {
  config: ResolvedConfig;
  warnings: string[];
}

/**
 * Effective configuration for a run (design §6): defaults < dashboard < `.github/ai-pr-review.yml` read from the
 * base branch at the base SHA. Because the file comes from the base, a PR (including a fork PR) cannot change its
 * own review settings by editing it.
 *
 * Sensitive keys in the file are dropped with a warning. A file that is missing is normal; one that is
 * unreadable, too large, not valid YAML or not valid against the schema produces a warning and the dashboard
 * configuration is used unchanged. Errors other than "not found" (rate limit, outage) are thrown so the job retries
 * instead of silently reviewing with different settings.
 */
export async function loadEffectiveConfig(options: RepoConfigOptions): Promise<RepoConfigResult> {
  const { client, repo, baseSha, dashboard, signal } = options;
  const warnings: string[] = [];

  let text: string | undefined;
  try {
    const content = await call(
      client,
      signal,
      "GET /repos/{owner}/{repo}/contents/{path}",
      { ...repoParams(repo), path: REPO_CONFIG_PATH, ref: baseSha },
      contentSchema,
    );
    if (content.type !== "file") {
      warnings.push(`${REPO_CONFIG_PATH} is not a regular file; ignored.`);
    } else if ((content.size ?? 0) > MAX_CONFIG_BYTES) {
      warnings.push(`${REPO_CONFIG_PATH} is larger than ${MAX_CONFIG_BYTES / 1024} KB; ignored.`);
    } else {
      text = decodeContent(content);
      if (text === undefined) warnings.push(`${REPO_CONFIG_PATH} could not be read; ignored.`);
    }
  } catch (err) {
    if (!isNotFound(err)) throw err;
  }

  let fromFile: RawConfig = {};
  if (text !== undefined) {
    const result = parseRepoFile(text);
    warnings.push(...result.warnings);
    fromFile = result.config;
  }

  return { config: mergeConfig(dashboard, fromFile), warnings };
}

/**
 * Parses and validates the repo file. Problems become warnings and yield an empty config; `valid` says whether the
 * file was usable (a file that only sets a dashboard-only key is still valid: that key is dropped with a warning).
 */
export function inspectRepoFile(text: string): {
  config: RawConfig;
  warnings: string[];
  valid: boolean;
} {
  const warnings: string[] = [];
  let raw: RawConfig;
  try {
    raw = parseConfigYaml(text);
  } catch (err) {
    const detail = err instanceof ConfigError ? err.message : "invalid YAML";
    return { config: {}, warnings: [`${detail} Using the dashboard settings.`], valid: false };
  }

  const config: RawConfig = {};
  for (const [key, value] of Object.entries(raw)) {
    if (SENSITIVE_CONFIG_KEYS.includes(key)) {
      warnings.push(`${REPO_CONFIG_PATH}: "${key}" can only be set in the dashboard; ignored.`);
    } else {
      config[key] = value;
    }
  }

  const checked = configSchema.partial().safeParse(config);
  if (!checked.success) {
    const problems = formatIssues(checked.error.issues, config);
    return {
      config: {},
      warnings: [
        ...warnings,
        `${REPO_CONFIG_PATH} is invalid (${problems.join("; ")}). Using the dashboard settings.`,
      ],
      valid: false,
    };
  }
  return { config, warnings, valid: true };
}

/** Parses and validates the repo file. Problems become warnings and yield an empty config. */
export function parseRepoFile(text: string): { config: RawConfig; warnings: string[] } {
  const { config, warnings } = inspectRepoFile(text);
  return { config, warnings };
}

export interface RepoFileReading {
  /** `applied`: the file sets these keys. `absent`: no file. `invalid`: there is a file but it cannot be used. */
  status: "applied" | "absent" | "invalid";
  /** The non-sensitive settings the file sets (empty unless `applied`). */
  config: RawConfig;
  /** A fixed sentence or the checks that failed, by key; never the file's text. Null when all is well. */
  message: string | null;
}

/**
 * Reads `.github/ai-pr-review.yml` at `ref` (the default branch, for display in the settings screen) and says
 * what it sets. Runs use `loadEffectiveConfig` at the base SHA instead; this is the same file read for a person to
 * look at. A missing file is normal; any other GitHub failure is thrown for the caller to report as unavailable.
 */
export async function readRepoFile(options: {
  client: ContextClient;
  repo: RepoRef;
  ref: string;
  signal?: AbortSignal | undefined;
}): Promise<RepoFileReading> {
  const { client, repo, ref, signal } = options;
  let content;
  try {
    content = await call(
      client,
      signal,
      "GET /repos/{owner}/{repo}/contents/{path}",
      { ...repoParams(repo), path: REPO_CONFIG_PATH, ref },
      contentSchema,
    );
  } catch (err) {
    if (isNotFound(err)) return { status: "absent", config: {}, message: null };
    throw err;
  }
  if (content.type !== "file") {
    return { status: "invalid", config: {}, message: `${REPO_CONFIG_PATH} is not a regular file.` };
  }
  if ((content.size ?? 0) > MAX_CONFIG_BYTES) {
    return {
      status: "invalid",
      config: {},
      message: `${REPO_CONFIG_PATH} is larger than ${MAX_CONFIG_BYTES / 1024} KB.`,
    };
  }
  const text = decodeContent(content);
  if (text === undefined) {
    return { status: "invalid", config: {}, message: `${REPO_CONFIG_PATH} could not be read.` };
  }
  const result = inspectRepoFile(text);
  if (!result.valid) {
    return { status: "invalid", config: {}, message: result.warnings.join(" ") };
  }
  return {
    status: "applied",
    config: result.config,
    message: result.warnings.length > 0 ? result.warnings.join(" ") : null,
  };
}
