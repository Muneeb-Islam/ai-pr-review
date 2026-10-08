import { eq } from "drizzle-orm";
import type { Database } from "../client";
import { repositories } from "../schema";
import { isUuid } from "../scope";
import type { Repo } from "../types";

/** WORKER: a repository by id with no caller scope (the worker acts for the platform, not for a user). */
export async function getRepositoryById(db: Database, repoId: string): Promise<Repo | undefined> {
  if (!isUuid(repoId)) return undefined;
  const [row] = await db.select().from(repositories).where(eq(repositories.id, repoId));
  return row;
}
