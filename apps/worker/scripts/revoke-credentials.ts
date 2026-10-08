// Emergency: deletes stored provider keys so that no further run can use them (docs/operations.md, "Revoking keys").
//   npm run credentials:revoke -- --all
//   npm run credentials:revoke -- --installation <GitHub installation id>
// Revoking at the provider comes first (the key may already be copied); this makes sure the platform stops using it.
import { createDb } from "@ai-pr-review/db";
import { revokeProviderCredentials } from "@ai-pr-review/db/system";
import { EnvError, loadEnv, serverEnvSchema } from "@ai-pr-review/shared";
import { z } from "zod";

const usage = "Usage: credentials:revoke -- --all | --installation <GitHub installation id>";

function parseArgs(argv: string[]): { all: true } | { githubInstallationId: number } {
  if (argv.length === 1 && argv[0] === "--all") return { all: true };
  if (argv.length === 2 && argv[0] === "--installation") {
    const id = Number(argv[1]);
    if (Number.isSafeInteger(id) && id > 0) return { githubInstallationId: id };
  }
  throw new Error(usage);
}

async function main(): Promise<void> {
  const scope = parseArgs(process.argv.slice(2));
  const env = loadEnv(z.object(serverEnvSchema.pick({ DATABASE_URL: true }).shape));
  const handle = createDb(env.DATABASE_URL, { max: 1 });
  try {
    const deleted = await revokeProviderCredentials(handle.db, scope);
    console.log(
      `Deleted ${deleted} stored provider key(s)${"all" in scope ? "" : ` of installation ${scope.githubInstallationId}`}. ` +
        "Runs of the affected repositories now fail with 'no key stored' until a new key is entered.",
    );
  } finally {
    await handle.close();
  }
}

main().catch((err: unknown) => {
  console.error(
    err instanceof EnvError || (err instanceof Error && err.message === usage)
      ? (err as Error).message
      : "Revoking failed",
  );
  process.exit(1);
});
