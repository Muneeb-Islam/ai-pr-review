import { eq } from "drizzle-orm";
import type { Database } from "../client";
import { reviewRuns } from "../schema";
import { isUuid } from "../scope";
import type { Run } from "../types";

/**
 * Loads a run by id with no caller scope: the worker job payload is just `{ runId }` (design §7).
 * The worker then uses `run.installationId` for every further, scoped, call.
 */
export async function getRunById(db: Database, runId: string): Promise<Run | undefined> {
  if (!isUuid(runId)) return undefined;
  const [row] = await db.select().from(reviewRuns).where(eq(reviewRuns.id, runId));
  return row;
}
