// Re-wraps stored provider keys with the current ENCRYPTION_KEY. Steps: see src/rotation.ts.
//   npm run credentials:rotate
import { keyringFromEnv } from "@ai-pr-review/core";
import { createDb } from "@ai-pr-review/db";
import { EnvError, loadEnv, serverEnvSchema } from "@ai-pr-review/shared";
import { z } from "zod";
import { rotateCredentials } from "../src/rotation";

const schema = serverEnvSchema
  .pick({
    DATABASE_URL: true,
    ENCRYPTION_KEY_VERSION: true,
    ENCRYPTION_KEY_PREVIOUS: true,
    ENCRYPTION_KEY_PREVIOUS_VERSION: true,
  })
  .extend({ ENCRYPTION_KEY: serverEnvSchema.shape.ENCRYPTION_KEY.unwrap() });

async function main(): Promise<void> {
  const env = loadEnv(z.object(schema.shape));
  const keyring = keyringFromEnv(env);
  const handle = createDb(env.DATABASE_URL, { max: 2 });
  try {
    const result = await rotateCredentials(handle.db, keyring);
    console.log(
      `Credentials re-wrapped to key version ${keyring.current.version}: ${result.rotated} rotated, ` +
        `${result.skipped} already current, ${result.failed.length} failed.`,
    );
    if (result.failed.length > 0) {
      console.error(
        "These records could not be read with the configured keys (is ENCRYPTION_KEY_PREVIOUS set?): " +
          result.failed.join(", "),
      );
      process.exitCode = 1;
    }
  } finally {
    await handle.close();
  }
}

main().catch((err: unknown) => {
  console.error(err instanceof EnvError ? err.message : "Rotation failed");
  process.exit(1);
});
