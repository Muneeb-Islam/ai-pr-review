// `npm run db:migrate`: applies pending migrations to DATABASE_URL.
import { loadEnv, serverEnvShape } from "@ai-pr-review/shared";
import { z } from "zod";
import { createDb, runMigrations } from "../src/index";

const { DATABASE_URL } = loadEnv(z.object({ DATABASE_URL: serverEnvShape.DATABASE_URL }));
const handle = createDb(DATABASE_URL, { max: 1 });
try {
  await runMigrations(handle.db);
  console.log("Migrations applied.");
} finally {
  await handle.close();
}
