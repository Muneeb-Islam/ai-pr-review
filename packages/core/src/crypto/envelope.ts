// Envelope encryption for provider API keys (design §9, PL-10).
//
// Every record gets its own random 32-byte data key (DEK). The key is used once, with AES-256-GCM, to encrypt
// the secret; the DEK itself is then encrypted ("wrapped") with the server's `ENCRYPTION_KEY` (the KEK),
// again with AES-256-GCM. The stored blob contains the wrapped DEK and the encrypted secret, and the row
// records which KEK version wrapped it, so the KEK can be rotated by re-wrapping DEKs only (the secret is
// never decrypted during rotation).
//
//   byte 0        format version (1)
//   bytes 1..12   nonce used to wrap the DEK
//   bytes 13..60  wrapped DEK (32 bytes) + GCM tag (16)
//   bytes 61..72  nonce used to encrypt the secret
//   bytes 73..    encrypted secret + GCM tag (16)
//
// Both operations use fresh random nonces, so encrypting the same secret twice never gives the same blob.
// The caller-supplied context (installation, repository and provider of the record) is authenticated but not
// stored: a blob copied to another row fails to decrypt.
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

const FORMAT_VERSION = 1;
const KEY_BYTES = 32;
const NONCE_BYTES = 12;
const TAG_BYTES = 16;
const WRAPPED_KEY_BYTES = KEY_BYTES + TAG_BYTES;
const DATA_OFFSET = 1 + NONCE_BYTES + WRAPPED_KEY_BYTES;

/** Decryption or unwrapping failed: wrong key or version, tampered data, or a different context. Never carries key material. */
export class DecryptionError extends Error {
  constructor(message = "Could not decrypt the stored secret") {
    super(message);
    this.name = "DecryptionError";
  }
}

export interface KeyEntry {
  version: number;
  key: Buffer;
}

/** The server's key-encryption keys: the current one (used to encrypt) and older ones still needed to read. */
export class Keyring {
  private readonly keys = new Map<number, Buffer>();

  constructor(
    readonly current: KeyEntry,
    previous: KeyEntry[] = [],
  ) {
    for (const entry of [current, ...previous]) {
      if (!Number.isInteger(entry.version) || entry.version < 1) {
        throw new Error("Encryption key versions must be positive integers");
      }
      if (entry.key.length !== KEY_BYTES) throw new Error("Encryption keys must be 32 bytes");
      if (this.keys.has(entry.version)) throw new Error("Duplicate encryption key version");
      this.keys.set(entry.version, entry.key);
    }
  }

  get(version: number): Buffer | undefined {
    return this.keys.get(version);
  }
}

/** Builds a keyring from the environment values (`ENCRYPTION_KEY*`, base64). */
export function keyringFromEnv(env: {
  ENCRYPTION_KEY: string;
  ENCRYPTION_KEY_VERSION: number;
  ENCRYPTION_KEY_PREVIOUS?: string | undefined;
  ENCRYPTION_KEY_PREVIOUS_VERSION?: number | undefined;
}): Keyring {
  const previous: KeyEntry[] = [];
  if (env.ENCRYPTION_KEY_PREVIOUS) {
    previous.push({
      version: env.ENCRYPTION_KEY_PREVIOUS_VERSION ?? env.ENCRYPTION_KEY_VERSION - 1,
      key: Buffer.from(env.ENCRYPTION_KEY_PREVIOUS, "base64"),
    });
  }
  return new Keyring(
    { version: env.ENCRYPTION_KEY_VERSION, key: Buffer.from(env.ENCRYPTION_KEY, "base64") },
    previous,
  );
}

export interface EncryptedSecret {
  ciphertext: Buffer;
  /** Version of the key that wrapped the data key; store it next to the ciphertext. */
  keyVersion: number;
}

const wrapAad = (version: number) => Buffer.from(`ai-pr-review:dek:v${version}`);
const dataAad = (context: string) => Buffer.from(`ai-pr-review:secret:${context}`);

function gcmEncrypt(key: Buffer, nonce: Buffer, plaintext: Buffer, aad: Buffer): Buffer {
  const cipher = createCipheriv("aes-256-gcm", key, nonce);
  cipher.setAAD(aad);
  return Buffer.concat([cipher.update(plaintext), cipher.final(), cipher.getAuthTag()]);
}

function gcmDecrypt(key: Buffer, nonce: Buffer, sealed: Buffer, aad: Buffer): Buffer {
  if (sealed.length < TAG_BYTES) throw new DecryptionError();
  const decipher = createDecipheriv("aes-256-gcm", key, nonce);
  decipher.setAAD(aad);
  decipher.setAuthTag(sealed.subarray(sealed.length - TAG_BYTES));
  try {
    return Buffer.concat([
      decipher.update(sealed.subarray(0, sealed.length - TAG_BYTES)),
      decipher.final(),
    ]);
  } catch {
    throw new DecryptionError();
  }
}

/** Encrypts `secret` under a fresh data key wrapped with the current key. `context` ties the blob to its record. */
export function encryptSecret(secret: string, keyring: Keyring, context = ""): EncryptedSecret {
  const dek = randomBytes(KEY_BYTES);
  const wrapNonce = randomBytes(NONCE_BYTES);
  const dataNonce = randomBytes(NONCE_BYTES);
  const { version, key } = keyring.current;
  try {
    const wrapped = gcmEncrypt(key, wrapNonce, dek, wrapAad(version));
    const sealed = gcmEncrypt(dek, dataNonce, Buffer.from(secret, "utf8"), dataAad(context));
    return {
      ciphertext: Buffer.concat([
        Buffer.from([FORMAT_VERSION]),
        wrapNonce,
        wrapped,
        dataNonce,
        sealed,
      ]),
      keyVersion: version,
    };
  } finally {
    dek.fill(0);
  }
}

function unwrapKey(blob: Buffer, keyVersion: number, keyring: Keyring): Buffer {
  if (blob.length < DATA_OFFSET + NONCE_BYTES + TAG_BYTES || blob[0] !== FORMAT_VERSION) {
    throw new DecryptionError();
  }
  const kek = keyring.get(keyVersion);
  if (!kek)
    throw new DecryptionError("No encryption key is configured for this record's key version");
  return gcmDecrypt(
    kek,
    blob.subarray(1, 1 + NONCE_BYTES),
    blob.subarray(1 + NONCE_BYTES, DATA_OFFSET),
    wrapAad(keyVersion),
  );
}

export function decryptSecret(
  ciphertext: Buffer,
  keyVersion: number,
  keyring: Keyring,
  context = "",
): string {
  const dek = unwrapKey(ciphertext, keyVersion, keyring);
  try {
    const plain = gcmDecrypt(
      dek,
      ciphertext.subarray(DATA_OFFSET, DATA_OFFSET + NONCE_BYTES),
      ciphertext.subarray(DATA_OFFSET + NONCE_BYTES),
      dataAad(context),
    );
    return plain.toString("utf8");
  } finally {
    dek.fill(0);
  }
}

/**
 * Key rotation: unwraps the data key with the key of `keyVersion` and wraps it again with the current key.
 * The encrypted secret part is copied as is, so the secret is never exposed during rotation.
 */
export function rewrapSecret(
  ciphertext: Buffer,
  keyVersion: number,
  keyring: Keyring,
): EncryptedSecret {
  const dek = unwrapKey(ciphertext, keyVersion, keyring);
  try {
    const wrapNonce = randomBytes(NONCE_BYTES);
    const { version, key } = keyring.current;
    const wrapped = gcmEncrypt(key, wrapNonce, dek, wrapAad(version));
    return {
      ciphertext: Buffer.concat([
        Buffer.from([FORMAT_VERSION]),
        wrapNonce,
        wrapped,
        ciphertext.subarray(DATA_OFFSET),
      ]),
      keyVersion: version,
    };
  } finally {
    dek.fill(0);
  }
}
