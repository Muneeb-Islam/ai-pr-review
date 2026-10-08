import { and, asc, eq, inArray, isNull, ne, notInArray, or, sql } from "drizzle-orm";
import type { ProviderName } from "@ai-pr-review/shared";
import type { Database } from "../client";
import { installations, providerCredentials } from "../schema";
import { isUuid } from "../scope";

export interface WorkerCredential {
  id: string;
  repoId: string | null;
  provider: ProviderName;
  keyVersion: number;
  /** Opaque encrypted bytes; decrypt in memory in the worker (Phase 4) and never log or serialise them. */
  ciphertext: Buffer;
}

/**
 * WORKER ONLY. The one function that returns key ciphertext. It resolves the credential for a run:
 * the repository's own key for the provider if it has one, otherwise the installation default.
 * It is limited to `installationId`, so it can never return another installation's key.
 */
export async function getProviderCredentialForWorker(
  db: Database,
  installationId: string,
  repoId: string | undefined,
  provider: ProviderName,
): Promise<WorkerCredential | undefined> {
  if (!isUuid(installationId) || (repoId !== undefined && !isUuid(repoId))) return undefined;
  const [row] = await db
    .select({
      id: providerCredentials.id,
      repoId: providerCredentials.repoId,
      provider: providerCredentials.provider,
      keyVersion: providerCredentials.keyVersion,
      ciphertext: providerCredentials.ciphertext,
    })
    .from(providerCredentials)
    .where(
      and(
        eq(providerCredentials.installationId, installationId),
        eq(providerCredentials.provider, provider),
        repoId === undefined
          ? isNull(providerCredentials.repoId)
          : or(eq(providerCredentials.repoId, repoId), isNull(providerCredentials.repoId)),
      ),
    )
    // A repository override sorts before the installation default (NULLs last).
    .orderBy(sql`${providerCredentials.repoId} asc nulls last`)
    .limit(1);
  return row;
}

export interface CredentialForRotation {
  id: string;
  keyVersion: number;
  ciphertext: Buffer;
}

/**
 * KEY ROTATION ONLY: credentials still wrapped with a key version other than the current one, oldest key
 * first. `excludeIds` skips records already handled (including ones that could not be read), so a pass
 * always reaches the records behind them.
 */
export async function listCredentialsForRotation(
  db: Database,
  currentKeyVersion: number,
  limit = 200,
  excludeIds: readonly string[] = [],
): Promise<CredentialForRotation[]> {
  return db
    .select({
      id: providerCredentials.id,
      keyVersion: providerCredentials.keyVersion,
      ciphertext: providerCredentials.ciphertext,
    })
    .from(providerCredentials)
    .where(
      and(
        ne(providerCredentials.keyVersion, currentKeyVersion),
        excludeIds.length > 0 ? notInArray(providerCredentials.id, [...excludeIds]) : undefined,
      ),
    )
    .orderBy(asc(providerCredentials.keyVersion), asc(providerCredentials.id))
    .limit(limit);
}

/**
 * KEY ROTATION ONLY: swaps in re-wrapped ciphertext. The update is conditional on the version that was read,
 * so a concurrent PUT of a new key is never overwritten. Returns false when the row changed meanwhile.
 */
export async function replaceCredentialCiphertext(
  db: Database,
  credentialId: string,
  expectedKeyVersion: number,
  ciphertext: Buffer,
  newKeyVersion: number,
): Promise<boolean> {
  if (!isUuid(credentialId)) return false;
  const rows = await db
    .update(providerCredentials)
    .set({ ciphertext, keyVersion: newKeyVersion })
    .where(
      and(
        eq(providerCredentials.id, credentialId),
        eq(providerCredentials.keyVersion, expectedKeyVersion),
      ),
    )
    .returning({ id: providerCredentials.id });
  return rows.length > 0;
}

/**
 * EMERGENCY ONLY (docs/operations.md, "Revoking keys"): deletes stored provider keys, for one installation or for all
 * of them. The next run of an affected repository fails with "no key stored" instead of using a key that may have been
 * exposed; nothing else is touched. Returns how many keys were deleted.
 */
export async function revokeProviderCredentials(
  db: Database,
  scope: { all: true } | { githubInstallationId: number },
): Promise<number> {
  if ("all" in scope) {
    const rows = await db.delete(providerCredentials).returning({ id: providerCredentials.id });
    return rows.length;
  }
  const rows = await db
    .delete(providerCredentials)
    .where(
      inArray(
        providerCredentials.installationId,
        db
          .select({ id: installations.id })
          .from(installations)
          .where(eq(installations.githubInstallationId, scope.githubInstallationId)),
      ),
    )
    .returning({ id: providerCredentials.id });
  return rows.length;
}
