import { and, asc, eq } from "drizzle-orm";
import type { PostedCommentKind } from "@ai-pr-review/shared";
import type { Database } from "../client";
import { postedComments, reviewRuns } from "../schema";
import { inInstallations, isUuid, type InstallationIds } from "../scope";
import type { PostedComment } from "../types";
import { requireRun } from "./internal";

export interface NewPostedComment {
  kind: PostedCommentKind;
  githubId: number;
  /** Absent for the summary comment and the check run. */
  fingerprint?: string;
  headSha: string;
}

export async function recordPostedComment(
  db: Database,
  installationId: string,
  runId: string,
  input: NewPostedComment,
): Promise<PostedComment> {
  await requireRun(db, installationId, runId);
  const [row] = await db
    .insert(postedComments)
    .values({
      installationId,
      runId,
      kind: input.kind,
      githubId: input.githubId,
      fingerprint: input.fingerprint ?? null,
      headSha: input.headSha,
    })
    .returning();
  return row!;
}

export async function listPostedComments(
  db: Database,
  installationIds: InstallationIds,
  runId: string,
): Promise<PostedComment[]> {
  if (!isUuid(runId)) return [];
  return db
    .select()
    .from(postedComments)
    .where(
      and(
        eq(postedComments.runId, runId),
        inInstallations(postedComments.installationId, installationIds),
      ),
    )
    .orderBy(asc(postedComments.kind), asc(postedComments.githubId));
}

/**
 * Idempotency check before posting (design §12): was a comment with this fingerprint already posted
 * for this head SHA on any run of the repository?
 */
export async function findPostedCommentByFingerprint(
  db: Database,
  installationIds: InstallationIds,
  repoId: string,
  fingerprint: string,
  headSha: string,
): Promise<PostedComment | undefined> {
  if (!isUuid(repoId)) return undefined;
  const [row] = await db
    .select({ comment: postedComments })
    .from(postedComments)
    .innerJoin(
      reviewRuns,
      and(
        eq(postedComments.runId, reviewRuns.id),
        eq(postedComments.installationId, reviewRuns.installationId),
      ),
    )
    .where(
      and(
        inInstallations(postedComments.installationId, installationIds),
        eq(reviewRuns.repoId, repoId),
        eq(postedComments.fingerprint, fingerprint),
        eq(postedComments.headSha, headSha),
      ),
    )
    .limit(1);
  return row?.comment;
}
