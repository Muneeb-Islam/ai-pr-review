// `npm run db:migrate`: applies pending migrations. Connects as MIGRATION_DATABASE_URL when it is set (the owner role
// that may create tables), otherwise as DATABASE_URL. The apps themselves run as a plain role (docs/operations.md), so
// the role that migrates is not the role that serves requests. MIGRATIONS_FOLDER overrides where the SQL files are
// (the production image keeps them next to the bundled script).
import { EnvError, loadEnv, serverEnvShape } from "@ai-pr-review/shared";
import { z } from "zod";
import { createDb, runMigrations } from "../src/index";

try {
  const env = loadEnv(
    z.object({
      DATABASE_URL: serverEnvShape.DATABASE_URL.optional(),
      MIGRATION_DATABASE_URL: serverEnvShape.DATABASE_URL.optional(),
      MIGRATIONS_FOLDER: z.string().min(1).optional(),
    }),
  );
  const url = env.MIGRATION_DATABASE_URL ?? env.DATABASE_URL;
  if (!url) throw new EnvError(["DATABASE_URL"], []);
  const handle = createDb(url, { max: 1 });
  try {
    await runMigrations(handle.db, env.MIGRATIONS_FOLDER);
    console.log("Migrations applied.");
  } finally {
    await handle.close();
  }
} catch (err) {
  // Names only: a driver error can quote the connection string.
  console.error(
    err instanceof EnvError
      ? err.message
      : `Migration failed (${err instanceof Error ? err.name : "error"})`,
  );
  process.exit(1);
}
