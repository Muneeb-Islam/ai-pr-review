// WORKER ONLY: the one place a provider API key is decrypted (design §9, PL-10, AC-18).
//
// The api encrypts and stores keys but has no code path that reads them back. Decryption lives here, next to
// the system-level query that returns ciphertext, so the plaintext key exists only in the memory of the worker
// process, only for the duration of a review. Do not log, serialise, queue or return the result of this
// function anywhere; hand `apiKey` straight to the provider adapter.
import { credentialContext, decryptSecret, type Keyring } from "@ai-pr-review/core";
import type { Database } from "@ai-pr-review/db";
import {
  getPlatformCredentialForWorker,
  getProviderCredentialForWorker,
  getRepositoryById,
} from "@ai-pr-review/db/system";
import { registerSecret, type ProviderName } from "@ai-pr-review/shared";

export interface DecryptedCredential {
  provider: ProviderName;
  /** The plaintext key. Memory only. */
  apiKey: string;
  /** Which record answered: the repository's own key wins over the installation default. */
  scope: "repository" | "installation" | "global";
}

export interface CredentialDeps {
  db: Database;
  keyring: Keyring;
}

/**
 * The key to use for a repository and provider: the repository's own key if it has one, otherwise the
 * installation default, otherwise `undefined` (the run then fails with a clear "no provider key" message).
 * Throws `DecryptionError` if a stored key cannot be read (wrong `ENCRYPTION_KEY`, damaged record).
 */
export async function getDecryptedCredential(
  deps: CredentialDeps,
  repoId: string,
  provider: ProviderName,
): Promise<DecryptedCredential | undefined> {
  const repo = await getRepositoryById(deps.db, repoId);
  if (!repo) return undefined;

  const stored = await getProviderCredentialForWorker(
    deps.db,
    repo.installationId,
    repo.id,
    provider,
  );
  if (!stored) return getPlatformCredential(deps, provider);

  const apiKey = decryptSecret(
    stored.ciphertext,
    stored.keyVersion,
    deps.keyring,
    credentialContext({ installationId: repo.installationId, repoId: stored.repoId }, provider),
  );
  // From here on the key is masked in every log line of this process, whatever field it ends up in.
  registerSecret(apiKey);
  return { provider, apiKey, scope: stored.repoId === null ? "installation" : "repository" };
}

/**
 * The platform-wide key of a provider (set by a platform administrator), used when neither the repository nor its
 * installation has a key for it. Encrypted under its own context, so it cannot be swapped in from another row.
 */
async function getPlatformCredential(
  deps: CredentialDeps,
  provider: ProviderName,
): Promise<DecryptedCredential | undefined> {
  const stored = await getPlatformCredentialForWorker(deps.db, provider);
  if (!stored) return undefined;
  const apiKey = decryptSecret(
    stored.ciphertext,
    stored.keyVersion,
    deps.keyring,
    credentialContext({ installationId: "platform" }, provider),
  );
  registerSecret(apiKey);
  return { provider, apiKey, scope: "global" };
}
