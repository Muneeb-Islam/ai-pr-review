// Provider keys are write-only (PL-10, AC-18): they go in encrypted, and what comes back is only the provider,
// the last four characters and a timestamp. Decryption exists in the worker only (apps/worker).
import { credentialContext, encryptSecret, validateBaseUrl } from "@ai-pr-review/core";
import {
  deletePlatformCredential,
  deleteProviderCredential,
  getPlatformAiSettings,
  listPlatformCredentials,
  putPlatformCredential,
  updatePlatformAiSettings,
  getInstallationSettings,
  getRepoSettings,
  listProviderCredentials,
  putProviderCredential,
  type CredentialInfo,
} from "@ai-pr-review/db";
import {
  ConfigError,
  PROVIDERS,
  resolveEffectiveSettings,
  type ProviderName,
} from "@ai-pr-review/shared";
import { isPlatformAdmin } from "../config";
import { DEFAULT_BASE_URLS } from "../credentials/probe";
import { forbidden, notFound, validationError } from "../http/errors";
import type { Handlers, Platform } from "../http/platform";
import { audit } from "./audit";

type CredentialHandlers = Pick<
  Handlers,
  | "listRepoCredentials"
  | "putRepoCredential"
  | "deleteRepoCredential"
  | "testRepoCredential"
  | "listInstallationCredentials"
  | "putInstallationCredential"
  | "deleteInstallationCredential"
  | "testInstallationCredential"
  | "getPlatformAi"
  | "patchPlatformAi"
  | "putPlatformAiCredential"
  | "deletePlatformAiCredential"
>;

export function toCredentialDto(credential: CredentialInfo) {
  return {
    id: credential.id,
    provider: credential.provider,
    scope: credential.repoId === null ? ("installation" as const) : ("repository" as const),
    last4: credential.last4,
    created_at: credential.createdAt.toISOString(),
  };
}

interface Scope {
  installationId: string;
  repoId?: string;
  /** `repo:<id>` or `installation:<id>`, for the audit log. */
  target: string;
}

async function list(platform: Platform, scope: Scope) {
  const items = await listProviderCredentials(platform.db, [scope.installationId], {
    installationId: scope.installationId,
    repoId: scope.repoId ?? null,
  });
  return { items: items.map(toCredentialDto) };
}

async function put(
  platform: Platform,
  scope: Scope,
  userId: string,
  input: { provider: ProviderName; api_key: string },
) {
  const { ciphertext, keyVersion } = encryptSecret(
    input.api_key,
    platform.keyring,
    credentialContext(scope, input.provider),
  );
  const stored = await putProviderCredential(platform.db, scope.installationId, {
    ...(scope.repoId ? { repoId: scope.repoId } : {}),
    provider: input.provider,
    ciphertext,
    keyVersion,
    last4: input.api_key.slice(-4),
    createdBy: userId,
  });
  await audit(platform.db, scope.installationId, userId, "credential.put", scope.target, {
    provider: input.provider,
    scope: scope.repoId ? "repository" : "installation",
  });
  return { credential: toCredentialDto(stored) };
}

async function remove(platform: Platform, scope: Scope, userId: string, provider: ProviderName) {
  const existing = (
    await listProviderCredentials(platform.db, [scope.installationId], {
      installationId: scope.installationId,
      repoId: scope.repoId ?? null,
    })
  ).find((c) => c.provider === provider);
  if (!existing) throw notFound();
  await deleteProviderCredential(platform.db, scope.installationId, existing.id);
  await audit(platform.db, scope.installationId, userId, "credential.delete", scope.target, {
    provider,
    scope: scope.repoId ? "repository" : "installation",
  });
  return { ok: true as const };
}

/**
 * Makes one minimal call to the provider with the key from the request (not a stored one: stored keys are
 * decrypted by the worker only). The endpoint is the configured `base_url` when it is for this provider, else
 * the provider's default; either way it passes the same SSRF checks as the setting itself.
 */
async function test(
  platform: Platform,
  scope: Scope,
  input: { provider: ProviderName; api_key: string },
) {
  const ids = [scope.installationId];
  const layers = [
    (await getInstallationSettings(platform.db, ids, scope.installationId))?.config ?? {},
    ...(scope.repoId
      ? [(await getRepoSettings(platform.db, ids, scope.repoId))?.config ?? {}]
      : []),
  ];
  let configured: string | null = null;
  try {
    const effective = resolveEffectiveSettings(...layers);
    if (effective.provider === input.provider) configured = effective.base_url;
  } catch (err) {
    if (!(err instanceof ConfigError)) throw err;
  }

  const checked = await validateBaseUrl(
    configured ?? DEFAULT_BASE_URLS[input.provider],
    platform.resolveHost ? { resolve: platform.resolveHost } : {},
  );
  if (!checked.ok) return { ok: false, message: `The endpoint is not allowed: ${checked.reason}.` };
  const result = await platform.probe.check({
    provider: input.provider,
    apiKey: input.api_key,
    baseUrl: checked.url,
  });
  // The probe is meant to answer with fixed sentences. Whatever it returns, the key that was sent never comes back.
  return { ...result, message: result.message.split(input.api_key).join("[redacted]") };
}

const repoScope = (repo: { id: string; installationId: string }): Scope => ({
  installationId: repo.installationId,
  repoId: repo.id,
  target: `repo:${repo.id}`,
});
const installationScope = (installation: { id: string }): Scope => ({
  installationId: installation.id,
  target: `installation:${installation.id}`,
});

// ----- the platform-wide AI setting: platform administrators only -----

/** The key's encryption context. The worker builds the same one (apps/worker/src/credentials.ts). */
export const PLATFORM_CONTEXT_SCOPE = { installationId: "platform" } as const;

function requirePlatformAdmin(platform: Platform, login: string): void {
  if (!isPlatformAdmin(platform.config, login)) {
    throw forbidden("Only platform administrators can change the platform-wide AI setting");
  }
}

async function platformView(platform: Platform) {
  const [settings, keys] = await Promise.all([
    getPlatformAiSettings(platform.db),
    listPlatformCredentials(platform.db),
  ]);
  return {
    active_provider: settings.activeProvider,
    providers: PROVIDERS.map((provider) => {
      const key = keys.find((k) => k.provider === provider);
      return {
        provider,
        last4: key?.last4 ?? null,
        key_added_at: key ? key.createdAt.toISOString() : null,
        model: settings.models[provider] ?? null,
      };
    }),
  };
}

const platformHandlers = {
  getPlatformAi: async ({ platform, auth }) => {
    requirePlatformAdmin(platform, auth.user.login);
    return platformView(platform);
  },

  patchPlatformAi: async ({ platform, auth, body }) => {
    requirePlatformAdmin(platform, auth.user.login);
    const before = await platformView(platform);
    const next = body.active_provider === undefined ? before.active_provider : body.active_provider;
    if (next !== null) {
      const row = before.providers.find((p) => p.provider === next)!;
      const model = body.models?.[next] === undefined ? row.model : body.models[next] || null;
      if (row.last4 === null) {
        throw validationError([`Add a ${next} key before making it the active provider`]);
      }
      if (!model) throw validationError([`Enter a model for ${next} before making it active`]);
    }
    await updatePlatformAiSettings(
      platform.db,
      {
        ...(body.active_provider !== undefined ? { activeProvider: body.active_provider } : {}),
        ...(body.models ? { models: body.models } : {}),
      },
      auth.user.id,
    );
    return platformView(platform);
  },

  putPlatformAiCredential: async ({ platform, auth, body }) => {
    requirePlatformAdmin(platform, auth.user.login);
    const { ciphertext, keyVersion } = encryptSecret(
      body.api_key,
      platform.keyring,
      credentialContext(PLATFORM_CONTEXT_SCOPE, body.provider),
    );
    await putPlatformCredential(platform.db, {
      provider: body.provider,
      ciphertext,
      keyVersion,
      last4: body.api_key.slice(-4),
      createdBy: auth.user.id,
    });
    return platformView(platform);
  },

  deletePlatformAiCredential: async ({ platform, auth, query }) => {
    requirePlatformAdmin(platform, auth.user.login);
    if (!(await deletePlatformCredential(platform.db, query.provider))) throw notFound();
    return platformView(platform);
  },
} satisfies Pick<
  Handlers,
  "getPlatformAi" | "patchPlatformAi" | "putPlatformAiCredential" | "deletePlatformAiCredential"
>;

export const credentialHandlers: CredentialHandlers = {
  listRepoCredentials: ({ platform, repo }) => list(platform, repoScope(repo)),
  putRepoCredential: ({ platform, repo, auth, body }) =>
    put(platform, repoScope(repo), auth.user.id, body),
  deleteRepoCredential: ({ platform, repo, auth, query }) =>
    remove(platform, repoScope(repo), auth.user.id, query.provider),
  testRepoCredential: ({ platform, repo, body }) => test(platform, repoScope(repo), body),

  listInstallationCredentials: ({ platform, installation }) =>
    list(platform, installationScope(installation)),
  putInstallationCredential: ({ platform, installation, auth, body }) =>
    put(platform, installationScope(installation), auth.user.id, body),
  deleteInstallationCredential: ({ platform, installation, auth, query }) =>
    remove(platform, installationScope(installation), auth.user.id, query.provider),
  testInstallationCredential: ({ platform, installation, body }) =>
    test(platform, installationScope(installation), body),

  ...platformHandlers,
};
