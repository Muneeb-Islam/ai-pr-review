import { and, eq, isNull, or, sql } from "drizzle-orm";
import type { ProviderName } from "@ai-pr-review/shared";
import type { Database } from "../client";
import { providerCredentials } from "../schema";
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
