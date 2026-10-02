import { fileURLToPath } from "node:url";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import type { Database } from "./client";

/**
 * Default location of the generated SQL migrations. It is resolved relative to this source file, so it
 * works from source (tsx, vitest) but not from an esbuild bundle: deploys run `npm run db:migrate` from
 * the workspace (or pass `migrationsFolder`) before the apps start (design §16).
 */
export const MIGRATIONS_FOLDER = fileURLToPath(new URL("../migrations", import.meta.url));

/** Applies every pending migration. Forward-only; safe to call repeatedly. */
export async function runMigrations(
  db: Database,
  migrationsFolder: string = MIGRATIONS_FOLDER,
): Promise<void> {
  await migrate(db, { migrationsFolder });
}
