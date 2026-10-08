import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  DecryptionError,
  Keyring,
  decryptSecret,
  encryptSecret,
  keyringFromEnv,
  rewrapSecret,
} from "./envelope";

const keyringV1 = () => new Keyring({ version: 1, key: randomBytes(32) });
const SECRET = "sk-test-0123456789abcdef";

describe("envelope encryption", () => {
  it("round-trips a secret and records the key version", () => {
    const ring = keyringV1();
    const { ciphertext, keyVersion } = encryptSecret(SECRET, ring, "ctx");
    expect(keyVersion).toBe(1);
    expect(decryptSecret(ciphertext, keyVersion, ring, "ctx")).toBe(SECRET);
  });

  it("never stores the secret in the clear and gives different ciphertext for equal input (AC-18)", () => {
    const ring = keyringV1();
    const a = encryptSecret(SECRET, ring);
    const b = encryptSecret(SECRET, ring);
    expect(a.ciphertext.equals(b.ciphertext)).toBe(false);
    expect(a.ciphertext.includes(Buffer.from(SECRET))).toBe(false);
    expect(a.ciphertext.includes(Buffer.from(SECRET.slice(-8)))).toBe(false);
  });

  it("handles unicode and empty-ish secrets", () => {
    const ring = keyringV1();
    for (const value of ["clé-🔑-秘密", "x"]) {
      const { ciphertext, keyVersion } = encryptSecret(value, ring);
      expect(decryptSecret(ciphertext, keyVersion, ring)).toBe(value);
    }
  });

  it("fails with the wrong key, a tampered blob, a truncated blob or another context", () => {
    const ring = keyringV1();
    const { ciphertext } = encryptSecret(SECRET, ring, "repo-a");

    expect(() => decryptSecret(ciphertext, 1, keyringV1(), "repo-a")).toThrow(DecryptionError);
    expect(() => decryptSecret(ciphertext, 1, ring, "repo-b")).toThrow(DecryptionError);
    expect(() => decryptSecret(ciphertext, 2, ring, "repo-a")).toThrow(DecryptionError);
    expect(() => decryptSecret(ciphertext.subarray(0, 40), 1, ring, "repo-a")).toThrow(
      DecryptionError,
    );

    for (const index of [0, 5, 30, 70, ciphertext.length - 1]) {
      const tampered = Buffer.from(ciphertext);
      tampered[index] = tampered[index]! ^ 0xff;
      expect(() => decryptSecret(tampered, 1, ring, "repo-a"), `byte ${index}`).toThrow(
        DecryptionError,
      );
    }
  });

  it("error messages never contain key material or the secret", () => {
    const ring = keyringV1();
    const { ciphertext } = encryptSecret(SECRET, ring);
    try {
      decryptSecret(ciphertext, 1, keyringV1());
      expect.unreachable();
    } catch (err) {
      const text = String((err as Error).message);
      expect(text).not.toContain(SECRET);
      expect(text).not.toContain(ring.current.key.toString("base64"));
    }
  });

  describe("rotation", () => {
    it("re-wraps the data key with the new key without touching the secret", () => {
      const oldKey = randomBytes(32);
      const oldRing = new Keyring({ version: 1, key: oldKey });
      const stored = encryptSecret(SECRET, oldRing, "ctx");

      const newRing = new Keyring({ version: 2, key: randomBytes(32) }, [
        { version: 1, key: oldKey },
      ]);
      // Old records stay readable while both keys are configured.
      expect(decryptSecret(stored.ciphertext, 1, newRing, "ctx")).toBe(SECRET);

      const rotated = rewrapSecret(stored.ciphertext, 1, newRing);
      expect(rotated.keyVersion).toBe(2);
      expect(rotated.ciphertext.equals(stored.ciphertext)).toBe(false);

      // After rotation the previous key is no longer needed.
      const onlyNew = new Keyring(newRing.current);
      expect(decryptSecret(rotated.ciphertext, 2, onlyNew, "ctx")).toBe(SECRET);
      expect(() => decryptSecret(stored.ciphertext, 1, onlyNew, "ctx")).toThrow(DecryptionError);
    });

    it("cannot re-wrap a record whose key is not configured", () => {
      const stored = encryptSecret(SECRET, keyringV1());
      expect(() => rewrapSecret(stored.ciphertext, 1, keyringV1())).toThrow(DecryptionError);
    });
  });

  describe("keyring", () => {
    it("rejects keys that are not 32 bytes and duplicate versions", () => {
      expect(() => new Keyring({ version: 1, key: randomBytes(16) })).toThrow();
      expect(
        () =>
          new Keyring({ version: 1, key: randomBytes(32) }, [{ version: 1, key: randomBytes(32) }]),
      ).toThrow();
      expect(() => new Keyring({ version: 0, key: randomBytes(32) })).toThrow();
    });

    it("is built from the environment values", () => {
      const current = randomBytes(32);
      const previous = randomBytes(32);
      const ring = keyringFromEnv({
        ENCRYPTION_KEY: current.toString("base64"),
        ENCRYPTION_KEY_VERSION: 3,
        ENCRYPTION_KEY_PREVIOUS: previous.toString("base64"),
      });
      expect(ring.current.version).toBe(3);
      expect(ring.get(2)?.equals(previous)).toBe(true);
    });
  });
});
