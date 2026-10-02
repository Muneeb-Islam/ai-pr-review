import { and, asc, eq } from "drizzle-orm";
import type { Database } from "../client";
import { installations } from "../schema";
import { inInstallations, isUuid, type InstallationIds } from "../scope";
import type { Installation } from "../types";

export async function listInstallations(
  db: Database,
  installationIds: InstallationIds,
): Promise<Installation[]> {
  return db
    .select()
    .from(installations)
    .where(inInstallations(installations.id, installationIds))
    .orderBy(asc(installations.accountLogin), asc(installations.id));
}

export async function getInstallation(
  db: Database,
  installationIds: InstallationIds,
  installationId: string,
): Promise<Installation | undefined> {
  if (!isUuid(installationId)) return undefined;
  const [row] = await db
    .select()
    .from(installations)
    .where(
      and(eq(installations.id, installationId), inInstallations(installations.id, installationIds)),
    );
  return row;
}
