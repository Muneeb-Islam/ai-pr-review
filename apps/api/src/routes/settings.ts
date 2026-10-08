import { validateBaseUrl } from "@ai-pr-review/core";
import {
  getInstallation,
  getInstallationSettings,
  getRepoSettings,
  setRepositoryEnabled,
  upsertInstallationSettings,
  upsertRepoSettings,
  type Installation,
  type Repo,
} from "@ai-pr-review/db";
import { getDailyUsage } from "@ai-pr-review/db/system";
import {
  applyConfigPatch,
  ConfigError,
  configLeafPaths,
  REPO_CONFIG_PATH,
  resolveEffectiveSettings,
  utcDayStart,
  validateDashboardConfig,
  type EffectiveSettings,
} from "@ai-pr-review/shared";
import { validationError } from "../http/errors";
import type { Handlers, Platform } from "../http/platform";
import { audit } from "./audit";

type SettingsHandlers = Pick<
  Handlers,
  "getRepoSettings" | "patchRepoSettings" | "getInstallationSettings" | "patchInstallationSettings"
>;

type Raw = Record<string, unknown>;

const iso = (date: Date | undefined) => (date ? date.toISOString() : null);

/** Effective settings for display. Layers were validated when stored, so a failure means damaged data. */
function effectiveOf(...layers: Raw[]): EffectiveSettings {
  try {
    return resolveEffectiveSettings(...layers);
  } catch (err) {
    if (err instanceof ConfigError) throw validationError(err.problems);
    throw err;
  }
}

/**
 * The shared checks for any settings change: the merged layer must satisfy the config schema (unknown keys
 * and bad values rejected by path), `base_url` must be a public HTTPS endpoint (SSRF, design §6), and the
 * layers together (`lowerLayers` below `next`) must resolve to a valid configuration.
 */
async function validateLayer(platform: Platform, next: Raw, lowerLayers: Raw[]): Promise<void> {
  const valid = validateDashboardConfig(next);
  if (!valid.ok) throw validationError(valid.problems);

  const baseUrl = next["base_url"];
  if (typeof baseUrl === "string") {
    const checked = await validateBaseUrl(
      baseUrl,
      platform.resolveHost ? { resolve: platform.resolveHost } : {},
    );
    if (!checked.ok) throw validationError([`base_url: ${checked.reason}`]);
  }
  effectiveOf(...lowerLayers, next);
}

/**
 * The repository file's state and the settings it sets. The file wins over the dashboard (design §6), so the
 * effective settings include it. A file that is not valid is reported as such and contributes nothing, as in a run.
 */
async function repoFileOf(platform: Platform, repo: Repo) {
  const none = (status: "absent" | "unavailable", message: string | null) => ({
    path: REPO_CONFIG_PATH,
    status,
    config: {} as Raw,
    message,
  });
  if (!platform.repoFile) {
    return none("unavailable", "Reading the repository file is not set up on this server.");
  }
  const installation = await getInstallation(
    platform.db,
    [repo.installationId],
    repo.installationId,
  );
  if (!installation) return none("absent", null);
  return platform.repoFile.read({
    repoId: repo.id,
    githubInstallationId: installation.githubInstallationId,
    fullName: repo.fullName,
    defaultBranch: repo.defaultBranch,
  });
}

async function repoSettingsResponse(platform: Platform, repo: Repo) {
  const ids = [repo.installationId];
  const [settings, installation, file] = await Promise.all([
    getRepoSettings(platform.db, ids, repo.id),
    getInstallationSettings(platform.db, ids, repo.installationId),
    repoFileOf(platform, repo),
  ]);
  const inherited = installation?.config ?? {};
  const config = settings?.config ?? {};

  const effective = effectiveOf(inherited, config, file.config);
  return {
    repo_id: repo.id,
    enabled: repo.enabled,
    config,
    inherited,
    effective,
    repo_file_keys: configLeafPaths(file.config),
    repo_file: { path: file.path, status: file.status, message: file.message },
    updated_at: iso(settings?.updatedAt),
    updated_by: settings?.updatedBy ?? null,
  };
}

async function installationSettingsResponse(platform: Platform, installation: Installation) {
  const settings = await getInstallationSettings(platform.db, [installation.id], installation.id);
  const now = platform.now?.() ?? new Date();
  const dayStart = utcDayStart(now);
  const usage = await getDailyUsage(platform.db, installation.id, dayStart);
  return {
    installation_id: installation.id,
    account_login: installation.accountLogin,
    config: settings?.config ?? {},
    effective: effectiveOf(settings?.config ?? {}),
    quotas: {
      runs_per_day: platform.config.quotas.runsPerDay,
      tokens_per_day: platform.config.quotas.tokensPerDay,
      read_only: true as const,
    },
    usage_today: {
      runs: usage.runs,
      tokens: usage.tokens,
      resets_at: new Date(dayStart.getTime() + 86_400_000).toISOString(),
    },
    retention: { days: platform.config.retentionDays, read_only: true as const },
    updated_at: iso(settings?.updatedAt),
    updated_by: settings?.updatedBy ?? null,
  };
}

export const settingsHandlers: SettingsHandlers = {
  async getRepoSettings({ platform, repo }) {
    return repoSettingsResponse(platform, repo);
  },

  async patchRepoSettings({ platform, repo, auth, body }) {
    const { enabled, config } = body;
    if (enabled === undefined && config === undefined) {
      throw validationError(["Nothing to update: send `enabled` and/or `config`"]);
    }
    const ids = [repo.installationId];

    if (config !== undefined) {
      const [existing, installation] = await Promise.all([
        getRepoSettings(platform.db, ids, repo.id),
        getInstallationSettings(platform.db, ids, repo.installationId),
      ]);
      const next = applyConfigPatch(existing?.config ?? {}, config);
      await validateLayer(platform, next, [installation?.config ?? {}]);
      await upsertRepoSettings(platform.db, repo.installationId, repo.id, next, auth.user.id);
    }
    if (enabled !== undefined) {
      await setRepositoryEnabled(platform.db, repo.installationId, repo.id, enabled);
    }

    await audit(
      platform.db,
      repo.installationId,
      auth.user.id,
      "settings.update",
      `repo:${repo.id}`,
      {
        keys: Object.keys(config ?? {}).sort(),
        ...(enabled !== undefined ? { enabled } : {}),
      },
    );
    const fresh = { ...repo, ...(enabled !== undefined ? { enabled } : {}) };
    return repoSettingsResponse(platform, fresh);
  },

  async getInstallationSettings({ platform, installation }) {
    return installationSettingsResponse(platform, installation);
  },

  async patchInstallationSettings({ platform, installation, auth, body }) {
    const existing = await getInstallationSettings(platform.db, [installation.id], installation.id);
    const next = applyConfigPatch(existing?.config ?? {}, body.config);
    await validateLayer(platform, next, []);
    await upsertInstallationSettings(platform.db, installation.id, next, auth.user.id);
    await audit(
      platform.db,
      installation.id,
      auth.user.id,
      "installation.settings.update",
      `installation:${installation.id}`,
      { keys: Object.keys(body.config).sort() },
    );
    return installationSettingsResponse(platform, installation);
  },
};
