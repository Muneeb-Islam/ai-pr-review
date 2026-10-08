// Key rotation for provider credentials (PL-10): re-wraps every record's data key with the current
// `ENCRYPTION_KEY` and stamps the new `key_version`. The secrets themselves are never decrypted.
//
//   1. generate a new key:  openssl rand -base64 32
//   2. set ENCRYPTION_KEY=<new>, ENCRYPTION_KEY_VERSION=<old version + 1>,
//      ENCRYPTION_KEY_PREVIOUS=<old key>, ENCRYPTION_KEY_PREVIOUS_VERSION=<old version>
//   3. restart api and worker (they read old records with the previous key, write new ones with the new key)
//   4. npm run credentials:rotate
//   5. when it reports nothing left, remove ENCRYPTION_KEY_PREVIOUS* and restart
import { DecryptionError, rewrapSecret, type Keyring } from "@ai-pr-review/core";
import type { Database } from "@ai-pr-review/db";
import { listCredentialsForRotation, replaceCredentialCiphertext } from "@ai-pr-review/db/system";

export interface RotationResult {
  /** Records re-wrapped with the current key. */
  rotated: number;
  /** Records changed by someone else while we worked (a new key was just stored); they are already current. */
  skipped: number;
  /** Records that could not be unwrapped (their key version is not in the keyring). Ids only, never contents. */
  failed: string[];
}

const BATCH = 200;

export async function rotateCredentials(db: Database, keyring: Keyring): Promise<RotationResult> {
  const result: RotationResult = { rotated: 0, skipped: 0, failed: [] };
  const handled = new Set<string>();

  for (;;) {
    // Records that failed stay wrapped with an old version; excluding what was handled ends the loop
    // when only those are left, and still reaches the records behind them.
    const batch = await listCredentialsForRotation(db, keyring.current.version, BATCH, [
      ...handled,
    ]);
    if (batch.length === 0) break;

    for (const row of batch) {
      handled.add(row.id);
      try {
        const next = rewrapSecret(row.ciphertext, row.keyVersion, keyring);
        const swapped = await replaceCredentialCiphertext(
          db,
          row.id,
          row.keyVersion,
          next.ciphertext,
          next.keyVersion,
        );
        if (swapped) result.rotated++;
        else result.skipped++;
      } catch (err) {
        if (!(err instanceof DecryptionError)) throw err;
        result.failed.push(row.id);
      }
    }
  }
  return result;
}
