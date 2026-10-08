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

/**
 * Records what a run posted. Idempotent: a comment already recorded for the run (same kind and GitHub id) is
 * kept as it is, so a re-processed run never lists the same comment twice. Returns the rows that were added.
 */
export async function recordPostedComments(
  db: Database,
  installationId: string,
  runId: string,
  inputs: readonly NewPostedComment[],
): Promise<PostedComment[]> {
  await requireRun(db, installationId, runId);
  if (inputs.length === 0) return [];
  return db.transaction(async (tx) => {
    const existing = await tx
      .select({ kind: postedComments.kind, githubId: postedComments.githubId })
      .from(postedComments)
      .where(
        and(eq(postedComments.runId, runId), eq(postedComments.installationId, installationId)),
      );
    const seen = new Set(existing.map((e) => `${e.kind}:${e.githubId}`));
    const fresh = inputs.filter((i) => {
      const key = `${i.kind}:${i.githubId}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
    if (fresh.length === 0) return [];
    return tx
      .insert(postedComments)
      .values(
        fresh.map((i) => ({
          installationId,
          runId,
          kind: i.kind,
          githubId: i.githubId,
          fingerprint: i.fingerprint ?? null,
          headSha: i.headSha,
        })),
      )
      .returning();
  });
}

/**
 * Fingerprints of the inline comments already posted for `headSha` on any run of the repository: what the
 * publisher must not post again (design §12).
 */
export async function listPostedFingerprints(
  db: Database,
  installationIds: InstallationIds,
  repoId: string,
  headSha: string,
): Promise<string[]> {
  if (!isUuid(repoId)) return [];
  const rows = await db
    .selectDistinct({ fingerprint: postedComments.fingerprint })
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
        eq(postedComments.kind, "review_comment"),
        eq(postedComments.headSha, headSha),
      ),
    );
  return rows.flatMap((r) => (r.fingerprint ? [r.fingerprint] : []));
}
