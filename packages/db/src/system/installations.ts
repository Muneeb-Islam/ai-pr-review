import { eq } from "drizzle-orm";
import type { AccountType, InstallationStatus } from "@ai-pr-review/shared";
import type { Database } from "../client";
import { installations } from "../schema";
import type { Installation } from "../types";

export interface InstallationInput {
  githubInstallationId: number;
  accountLogin: string;
  accountType: AccountType;
  /** Defaults to `active` for a new installation; an existing one keeps its status unless given. */
  status?: InstallationStatus;
}

/** Creates or refreshes an installation from a GitHub installation event. */
export async function upsertInstallationFromGitHub(
  db: Database,
  input: InstallationInput,
): Promise<Installation> {
  const [row] = await db
    .insert(installations)
    .values(input)
    .onConflictDoUpdate({
      target: installations.githubInstallationId,
      set: {
        accountLogin: input.accountLogin,
        accountType: input.accountType,
        ...(input.status ? { status: input.status } : {}),
      },
    })
    .returning();
  return row!;
}

export async function getInstallationByGitHubId(
  db: Database,
  githubInstallationId: number,
): Promise<Installation | undefined> {
  const [row] = await db
    .select()
    .from(installations)
    .where(eq(installations.githubInstallationId, githubInstallationId));
  return row;
}

/** Suspend, restore or delete (uninstall) an installation. Returns undefined if it is unknown. */
export async function setInstallationStatus(
  db: Database,
  githubInstallationId: number,
  status: InstallationStatus,
): Promise<Installation | undefined> {
  const [row] = await db
    .update(installations)
    .set({ status })
    .where(eq(installations.githubInstallationId, githubInstallationId))
    .returning();
  return row;
}
