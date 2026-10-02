// Helpers shared by the tenant modules. Not re-exported from the package.
import { and, eq } from "drizzle-orm";
import type { Database } from "../client";
import { NotFoundError } from "../errors";
import { EVIDENCE_MAX_CHARS, providerCredentials, reviewRuns } from "../schema";
import { isUuid } from "../scope";

/** Loads the run only if it belongs to `installationId`; the guard for writes that attach rows to a run. */
export async function requireRun(
  db: Database,
  installationId: string,
  runId: string,
): Promise<{ id: string; repoId: string }> {
  if (!isUuid(installationId) || !isUuid(runId)) throw new NotFoundError("Run");
  const [run] = await db
    .select({ id: reviewRuns.id, repoId: reviewRuns.repoId })
    .from(reviewRuns)
    .where(and(eq(reviewRuns.id, runId), eq(reviewRuns.installationId, installationId)));
  if (!run) throw new NotFoundError("Run");
  return run;
}

/** Every column except the ciphertext. Tenant-scoped functions select this and nothing else. */
export const credentialInfoColumns = {
  id: providerCredentials.id,
  installationId: providerCredentials.installationId,
  repoId: providerCredentials.repoId,
  provider: providerCredentials.provider,
  keyVersion: providerCredentials.keyVersion,
  last4: providerCredentials.last4,
  createdBy: providerCredentials.createdBy,
  createdAt: providerCredentials.createdAt,
} as const;

/** Evidence is a short excerpt (design §9); longer text is cut to the limit, counted in characters. */
export function truncateEvidence(evidence: string): string {
  const chars = Array.from(evidence);
  return chars.length <= EVIDENCE_MAX_CHARS
    ? evidence
    : chars.slice(0, EVIDENCE_MAX_CHARS).join("");
}
