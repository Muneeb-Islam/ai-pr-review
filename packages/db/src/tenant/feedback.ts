import { and, asc, eq } from "drizzle-orm";
import type { FeedbackVerdict } from "@ai-pr-review/shared";
import type { Database } from "../client";
import { NotFoundError } from "../errors";
import { findingFeedback, findings } from "../schema";
import { inInstallations, isUuid, type InstallationIds } from "../scope";
import type { FeedbackRecord } from "../types";

export interface NewFeedback {
  findingId: string;
  userId: string;
  verdict: FeedbackVerdict;
  note?: string;
}

/** One verdict per user per finding; sending feedback again replaces the verdict and note. */
export async function setFeedback(
  db: Database,
  installationId: string,
  input: NewFeedback,
): Promise<FeedbackRecord> {
  if (!isUuid(installationId) || !isUuid(input.findingId) || !isUuid(input.userId)) {
    throw new NotFoundError("Finding");
  }
  const [finding] = await db
    .select({ id: findings.id })
    .from(findings)
    .where(and(eq(findings.id, input.findingId), eq(findings.installationId, installationId)));
  if (!finding) throw new NotFoundError("Finding");

  const note = input.note ?? null;
  const [row] = await db
    .insert(findingFeedback)
    .values({
      findingId: input.findingId,
      installationId,
      userId: input.userId,
      verdict: input.verdict,
      note,
    })
    .onConflictDoUpdate({
      target: [findingFeedback.findingId, findingFeedback.userId],
      set: { verdict: input.verdict, note },
    })
    .returning();
  return row!;
}

export async function listFeedback(
  db: Database,
  installationIds: InstallationIds,
  findingId: string,
): Promise<FeedbackRecord[]> {
  if (!isUuid(findingId)) return [];
  return db
    .select()
    .from(findingFeedback)
    .where(
      and(
        eq(findingFeedback.findingId, findingId),
        inInstallations(findingFeedback.installationId, installationIds),
      ),
    )
    .orderBy(asc(findingFeedback.createdAt), asc(findingFeedback.userId));
}
