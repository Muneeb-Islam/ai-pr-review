import { and, asc, eq, isNull, sql } from "drizzle-orm";
import type { ProviderName } from "@ai-pr-review/shared";
import type { Database } from "../client";
import { InvalidInputError, NotFoundError } from "../errors";
import { providerCredentials, repositories } from "../schema";
import { inInstallations, isUuid, type InstallationIds } from "../scope";
import type { CredentialInfo } from "../types";
import { credentialInfoColumns } from "./internal";

export interface NewCredential {
  /** Omit for the installation-wide default; set for a per-repository override. */
  repoId?: string;
  provider: ProviderName;
  /** Opaque encrypted bytes. Encryption itself is Phase 4; the database never sees the key. */
  ciphertext: Buffer;
  keyVersion: number;
  /** The last four characters of the key, shown in the dashboard as a hint. */
  last4: string;
  createdBy?: string;
}

/**
 * Stores (or replaces) the key for a provider at one scope. Write-only: the result carries the
 * provider, `last4` and metadata but never the ciphertext (design §9).
 */
export async function putProviderCredential(
  db: Database,
  installationId: string,
  input: NewCredential,
): Promise<CredentialInfo> {
  if (!isUuid(installationId)) throw new NotFoundError("Installation");
  if (input.ciphertext.length === 0) throw new InvalidInputError("ciphertext must not be empty");
  if (input.last4.length < 1 || input.last4.length > 4) {
    throw new InvalidInputError("last4 must be 1 to 4 characters");
  }
  if (!Number.isInteger(input.keyVersion) || input.keyVersion < 1) {
    throw new InvalidInputError("keyVersion must be a positive integer");
  }
  if (input.repoId !== undefined) {
    const [repo] = isUuid(input.repoId)
      ? await db
          .select({ id: repositories.id })
          .from(repositories)
          .where(
            and(eq(repositories.id, input.repoId), eq(repositories.installationId, installationId)),
          )
      : [];
    if (!repo) throw new NotFoundError("Repository");
  }

  const values = {
    installationId,
    repoId: input.repoId ?? null,
    provider: input.provider,
    ciphertext: input.ciphertext,
    keyVersion: input.keyVersion,
    last4: input.last4,
    createdBy: input.createdBy ?? null,
  };
  const replace = {
    ciphertext: values.ciphertext,
    keyVersion: values.keyVersion,
    last4: values.last4,
    createdBy: values.createdBy,
    createdAt: new Date(),
  };
  const insert = db.insert(providerCredentials).values(values);
  const [row] = await (
    input.repoId === undefined
      ? insert.onConflictDoUpdate({
          target: [providerCredentials.installationId, providerCredentials.provider],
          targetWhere: sql`${providerCredentials.repoId} is null`,
          set: replace,
        })
      : insert.onConflictDoUpdate({
          target: [providerCredentials.repoId, providerCredentials.provider],
          targetWhere: sql`${providerCredentials.repoId} is not null`,
          set: replace,
        })
  ).returning(credentialInfoColumns);
  return row!;
}

export async function listProviderCredentials(
  db: Database,
  installationIds: InstallationIds,
  filters: { installationId?: string; repoId?: string | null } = {},
): Promise<CredentialInfo[]> {
  if (filters.installationId !== undefined && !isUuid(filters.installationId)) return [];
  if (typeof filters.repoId === "string" && !isUuid(filters.repoId)) return [];
  return db
    .select(credentialInfoColumns)
    .from(providerCredentials)
    .where(
      and(
        inInstallations(providerCredentials.installationId, installationIds),
        filters.installationId
          ? eq(providerCredentials.installationId, filters.installationId)
          : undefined,
        // `null` = installation-wide defaults only; a uuid = that repository's overrides only.
        filters.repoId === null ? isNull(providerCredentials.repoId) : undefined,
        typeof filters.repoId === "string"
          ? eq(providerCredentials.repoId, filters.repoId)
          : undefined,
      ),
    )
    .orderBy(asc(providerCredentials.provider), asc(providerCredentials.id));
}

export async function deleteProviderCredential(
  db: Database,
  installationId: string,
  credentialId: string,
): Promise<boolean> {
  if (!isUuid(installationId) || !isUuid(credentialId)) return false;
  const rows = await db
    .delete(providerCredentials)
    .where(
      and(
        eq(providerCredentials.id, credentialId),
        eq(providerCredentials.installationId, installationId),
      ),
    )
    .returning({ id: providerCredentials.id });
  return rows.length > 0;
}
