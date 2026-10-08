// The platform-wide AI setting: the provider every repository uses unless it chose its own, a model per provider
// and one key per provider. Not tenant data (no installation, no row-level security). Keys are write-only here,
// as for the per-installation ones: nothing in this file returns ciphertext (see `system/platform.ts`).
import { eq } from "drizzle-orm";
import type { ProviderName } from "@ai-pr-review/shared";
import type { Database } from "./client";
import { InvalidInputError } from "./errors";
import { platformCredentials, platformSettings } from "./schema";

export interface PlatformAiSettings {
  activeProvider: ProviderName | null;
  models: Partial<Record<ProviderName, string>>;
}

export interface PlatformCredentialInfo {
  provider: ProviderName;
  last4: string;
  createdAt: Date;
}

export async function getPlatformAiSettings(db: Database): Promise<PlatformAiSettings> {
  const [row] = await db.select().from(platformSettings).where(eq(platformSettings.id, 1));
  return {
    activeProvider: row?.activeProvider ?? null,
    models: (row?.models ?? {}) as PlatformAiSettings["models"],
  };
}

/** Updates the active provider and/or models (merged into the stored ones). A model of "" removes it. */
export async function updatePlatformAiSettings(
  db: Database,
  patch: {
    activeProvider?: ProviderName | null;
    models?: Partial<Record<ProviderName, string>>;
  },
  updatedBy?: string,
): Promise<PlatformAiSettings> {
  const current = await getPlatformAiSettings(db);
  const models: Record<string, string> = { ...current.models };
  for (const [provider, model] of Object.entries(patch.models ?? {})) {
    if (model === "") delete models[provider];
    else models[provider] = model;
  }
  const activeProvider =
    patch.activeProvider === undefined ? current.activeProvider : patch.activeProvider;
  await db
    .insert(platformSettings)
    .values({ id: 1, activeProvider, models, updatedBy: updatedBy ?? null })
    .onConflictDoUpdate({
      target: platformSettings.id,
      set: { activeProvider, models, updatedBy: updatedBy ?? null, updatedAt: new Date() },
    });
  return { activeProvider, models };
}

export async function listPlatformCredentials(db: Database): Promise<PlatformCredentialInfo[]> {
  return db
    .select({
      provider: platformCredentials.provider,
      last4: platformCredentials.last4,
      createdAt: platformCredentials.createdAt,
    })
    .from(platformCredentials);
}

export async function putPlatformCredential(
  db: Database,
  input: {
    provider: ProviderName;
    ciphertext: Buffer;
    keyVersion: number;
    last4: string;
    createdBy?: string;
  },
): Promise<PlatformCredentialInfo> {
  if (input.ciphertext.length === 0) throw new InvalidInputError("ciphertext must not be empty");
  if (input.last4.length < 1 || input.last4.length > 4) {
    throw new InvalidInputError("last4 must be 1 to 4 characters");
  }
  const values = {
    provider: input.provider,
    ciphertext: input.ciphertext,
    keyVersion: input.keyVersion,
    last4: input.last4,
    createdBy: input.createdBy ?? null,
  };
  const [row] = await db
    .insert(platformCredentials)
    .values(values)
    .onConflictDoUpdate({
      target: platformCredentials.provider,
      set: { ...values, createdAt: new Date() },
    })
    .returning({
      provider: platformCredentials.provider,
      last4: platformCredentials.last4,
      createdAt: platformCredentials.createdAt,
    });
  return row!;
}

/** Removes the key. If that provider was the active one, the platform has no active provider afterwards. */
export async function deletePlatformCredential(
  db: Database,
  provider: ProviderName,
): Promise<boolean> {
  const rows = await db
    .delete(platformCredentials)
    .where(eq(platformCredentials.provider, provider))
    .returning({ provider: platformCredentials.provider });
  const settings = await getPlatformAiSettings(db);
  if (settings.activeProvider === provider) {
    await updatePlatformAiSettings(db, { activeProvider: null });
  }
  return rows.length > 0;
}
