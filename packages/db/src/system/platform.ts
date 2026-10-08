import { eq } from "drizzle-orm";
import type { ProviderName } from "@ai-pr-review/shared";
import type { Database } from "../client";
import { platformCredentials } from "../schema";

/** WORKER ONLY: the platform-wide key for a provider, as ciphertext to decrypt in memory. Never log or serialise it. */
export async function getPlatformCredentialForWorker(
  db: Database,
  provider: ProviderName,
): Promise<{ keyVersion: number; ciphertext: Buffer } | undefined> {
  const [row] = await db
    .select({
      keyVersion: platformCredentials.keyVersion,
      ciphertext: platformCredentials.ciphertext,
    })
    .from(platformCredentials)
    .where(eq(platformCredentials.provider, provider));
  return row;
}
