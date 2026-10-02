// `npm run db:seed`: loads (or reloads) the demo installation into DATABASE_URL. Run `db:migrate` first.
import { loadEnv, serverEnvShape } from "@ai-pr-review/shared";
import { z } from "zod";
import { createDb } from "../src/index";
import { seedDemoData } from "../src/seed";

const { DATABASE_URL } = loadEnv(z.object({ DATABASE_URL: serverEnvShape.DATABASE_URL }));
const handle = createDb(DATABASE_URL, { max: 1 });
try {
  const summary = await seedDemoData(handle.db);
  console.log(
    `Seeded demo-org: ${summary.repositories} repositories, ${summary.runs} runs, ${summary.findings} findings.`,
  );
} finally {
  await handle.close();
}
