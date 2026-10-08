import { and, eq } from "drizzle-orm";
import { configSchema } from "@ai-pr-review/shared";
import type { Database } from "../client";
import { InvalidInputError, NotFoundError } from "../errors";
import { installationSettings, installations, repoSettings, repositories } from "../schema";
import { inInstallations, isUuid, type InstallationIds } from "../scope";
import type { InstallationSettingsRecord, RepoSettingsRecord } from "../types";

/**
 * Settings are stored as the dashboard layer of the configuration (defaults < dashboard < repo file,
 * design §6): any subset of the config keys. Unknown keys and invalid values are rejected; the raw
 * input is stored so defaults can still evolve.
 */
const storedConfigSchema = configSchema.partial();

export async function getRepoSettings(
  db: Database,
  installationIds: InstallationIds,
  repoId: string,
): Promise<RepoSettingsRecord | undefined> {
  if (!isUuid(repoId)) return undefined;
  const [row] = await db
    .select()
    .from(repoSettings)
    .where(
      and(
        eq(repoSettings.repoId, repoId),
        inInstallations(repoSettings.installationId, installationIds),
      ),
    );
  return row;
}

export async function upsertRepoSettings(
  db: Database,
  installationId: string,
  repoId: string,
  config: Record<string, unknown>,
  updatedBy?: string,
): Promise<RepoSettingsRecord> {
  if (!isUuid(installationId) || !isUuid(repoId)) throw new NotFoundError("Repository");
  const parsed = storedConfigSchema.safeParse(config);
  if (!parsed.success) {
    const problems = parsed.error.issues.map(
      (i) => `${i.path.join(".") || "(root)"}: ${i.message}`,
    );
    throw new InvalidInputError(`Invalid settings: ${problems.join("; ")}`);
  }
  const [repo] = await db
    .select({ id: repositories.id })
    .from(repositories)
    .where(and(eq(repositories.id, repoId), eq(repositories.installationId, installationId)));
  if (!repo) throw new NotFoundError("Repository");

  const [row] = await db
    .insert(repoSettings)
    .values({ repoId, installationId, config, updatedBy: updatedBy ?? null })
    .onConflictDoUpdate({
      target: repoSettings.repoId,
      set: { config, updatedBy: updatedBy ?? null, updatedAt: new Date() },
    })
    .returning();
  return row!;
}

/** The installation-wide defaults layer (design §6); sits between built-in defaults and repo settings. */
export async function getInstallationSettings(
  db: Database,
  installationIds: InstallationIds,
  installationId: string,
): Promise<InstallationSettingsRecord | undefined> {
  if (!isUuid(installationId)) return undefined;
  const [row] = await db
    .select()
    .from(installationSettings)
    .where(
      and(
        eq(installationSettings.installationId, installationId),
        inInstallations(installationSettings.installationId, installationIds),
      ),
    );
  return row;
}

export async function upsertInstallationSettings(
  db: Database,
  installationId: string,
  config: Record<string, unknown>,
  updatedBy?: string,
): Promise<InstallationSettingsRecord> {
  if (!isUuid(installationId)) throw new NotFoundError("Installation");
  const parsed = storedConfigSchema.safeParse(config);
  if (!parsed.success) {
    const problems = parsed.error.issues.map(
      (i) => `${i.path.join(".") || "(root)"}: ${i.message}`,
    );
    throw new InvalidInputError(`Invalid settings: ${problems.join("; ")}`);
  }
  const [installation] = await db
    .select({ id: installations.id })
    .from(installations)
    .where(eq(installations.id, installationId));
  if (!installation) throw new NotFoundError("Installation");

  const [row] = await db
    .insert(installationSettings)
    .values({ installationId, config, updatedBy: updatedBy ?? null })
    .onConflictDoUpdate({
      target: installationSettings.installationId,
      set: { config, updatedBy: updatedBy ?? null, updatedAt: new Date() },
    })
    .returning();
  return row!;
}
