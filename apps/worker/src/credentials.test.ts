// Worker-side decryption and key rotation (PL-10, AC-18) against a real PostgreSQL.
import { randomBytes } from "node:crypto";
import {
  credentialContext,
  decryptSecret,
  DecryptionError,
  encryptSecret,
  Keyring,
} from "@ai-pr-review/core";
import { putProviderCredential } from "@ai-pr-review/db";
import {
  createTenant,
  createTestDatabase,
  type Tenant,
  type TestDatabase,
} from "@ai-pr-review/db/testing";
import { createLogger, redact } from "@ai-pr-review/shared";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { getDecryptedCredential } from "./credentials";
import { rotateCredentials } from "./rotation";

let t: TestDatabase;
let alpha: Tenant;
let beta: Tenant;

const oldKey = randomBytes(32);
const ring1 = new Keyring({ version: 1, key: oldKey });

beforeAll(async () => {
  t = await createTestDatabase();
  alpha = await createTenant(t.db, "alpha");
  beta = await createTenant(t.db, "beta");
}, 60_000);
afterAll(async () => {
  await t.drop();
});

/** Stores a key the way the api does. */
async function store(
  tenant: Tenant,
  provider: "deepseek" | "openai" | "anthropic",
  apiKey: string,
  scope: { repoId?: string } = {},
  keyring: Keyring = ring1,
) {
  const { ciphertext, keyVersion } = encryptSecret(
    apiKey,
    keyring,
    credentialContext({ installationId: tenant.installation.id, ...scope }, provider),
  );
  return putProviderCredential(t.db, tenant.installation.id, {
    ...scope,
    provider,
    ciphertext,
    keyVersion,
    last4: apiKey.slice(-4),
  });
}

describe("getDecryptedCredential", () => {
  it("prefers the repository's own key over the installation default", async () => {
    await store(alpha, "deepseek", "sk-installation-default-0001");
    await store(alpha, "deepseek", "sk-repo-override-0002", { repoId: alpha.repo.id });

    const forApi = await getDecryptedCredential(
      { db: t.db, keyring: ring1 },
      alpha.repo.id,
      "deepseek",
    );
    expect(forApi).toEqual({
      provider: "deepseek",
      apiKey: "sk-repo-override-0002",
      scope: "repository",
    });
    const forWeb = await getDecryptedCredential(
      { db: t.db, keyring: ring1 },
      alpha.repo2.id,
      "deepseek",
    );
    expect(forWeb).toMatchObject({ apiKey: "sk-installation-default-0001", scope: "installation" });
  });

  it("returns nothing when no key exists for that provider", async () => {
    expect(
      await getDecryptedCredential({ db: t.db, keyring: ring1 }, alpha.repo.id, "anthropic"),
    ).toBeUndefined();
    expect(
      await getDecryptedCredential(
        { db: t.db, keyring: ring1 },
        "00000000-0000-4000-8000-000000000000",
        "deepseek",
      ),
    ).toBeUndefined();
    expect(
      await getDecryptedCredential({ db: t.db, keyring: ring1 }, "nope", "deepseek"),
    ).toBeUndefined();
  });

  it("never returns another installation's key", async () => {
    await store(beta, "openai", "sk-beta-only-0003");
    expect(
      await getDecryptedCredential({ db: t.db, keyring: ring1 }, alpha.repo.id, "openai"),
    ).toBeUndefined();
    expect(
      await getDecryptedCredential({ db: t.db, keyring: ring1 }, beta.repo.id, "openai"),
    ).toMatchObject({
      apiKey: "sk-beta-only-0003",
    });
  });

  it("fails with a DecryptionError, not a wrong key, when the server key is wrong or the record was moved", async () => {
    await expect(
      getDecryptedCredential(
        { db: t.db, keyring: new Keyring({ version: 1, key: randomBytes(32) }) },
        alpha.repo.id,
        "deepseek",
      ),
    ).rejects.toBeInstanceOf(DecryptionError);

    // A ciphertext copied from alpha's installation default into beta's row does not decrypt there.
    const alphaRow = await t.pool.query(
      "select ciphertext from provider_credentials where installation_id = $1 and repo_id is null and provider = 'deepseek'",
      [alpha.installation.id],
    );
    await t.pool.query(
      "update provider_credentials set ciphertext = $1 where installation_id = $2 and provider = 'openai'",
      [alphaRow.rows[0].ciphertext, beta.installation.id],
    );
    await expect(
      getDecryptedCredential({ db: t.db, keyring: ring1 }, beta.repo.id, "openai"),
    ).rejects.toBeInstanceOf(DecryptionError);
  });

  it("masks the key in every later log line", async () => {
    const lines: string[] = [];
    const logger = createLogger({}, (line) => lines.push(line));
    const found = await getDecryptedCredential(
      { db: t.db, keyring: ring1 },
      alpha.repo.id,
      "deepseek",
    );
    logger.info(`calling provider with ${found!.apiKey}`);
    expect(lines.join("")).not.toContain("sk-repo-override-0002");
    expect(redact(`x ${found!.apiKey} y`)).not.toContain("sk-repo-override-0002");
  });
});

describe("key rotation", () => {
  const ring2 = new Keyring({ version: 2, key: randomBytes(32) }, [{ version: 1, key: oldKey }]);

  it("re-wraps every record to the new key, keeps them readable, and a second run has nothing left", async () => {
    const rotation = await createTenant(t.db, "rotation");
    await store(rotation, "deepseek", "sk-rot-a-000000000001");
    await store(rotation, "deepseek", "sk-rot-b-000000000002", { repoId: rotation.repo.id });
    await store(rotation, "openai", "sk-rot-c-000000000003", { repoId: rotation.repo2.id });

    const before = await t.pool.query(
      "select id, ciphertext from provider_credentials where installation_id = $1 order by id",
      [rotation.installation.id],
    );

    const result = await rotateCredentials(t.db, ring2);
    // Other tenants' older records from the tests above are re-wrapped too: rotation is platform wide.
    expect(result.rotated).toBeGreaterThanOrEqual(3);
    expect(result.failed).toEqual([]);

    const after = await t.pool.query(
      "select id, ciphertext, key_version from provider_credentials where installation_id = $1 order by id",
      [rotation.installation.id],
    );
    expect(after.rows.map((r) => r.key_version)).toEqual([2, 2, 2]);
    for (const [i, row] of after.rows.entries()) {
      expect(row.ciphertext.equals(before.rows[i].ciphertext)).toBe(false);
    }

    // After rotation the old key is no longer needed to read anything.
    const onlyNew = new Keyring(ring2.current);
    expect(
      await getDecryptedCredential({ db: t.db, keyring: onlyNew }, rotation.repo.id, "deepseek"),
    ).toMatchObject({
      apiKey: "sk-rot-b-000000000002",
    });
    expect(
      await getDecryptedCredential({ db: t.db, keyring: onlyNew }, rotation.repo2.id, "openai"),
    ).toMatchObject({
      apiKey: "sk-rot-c-000000000003",
    });
    expect(
      await getDecryptedCredential({ db: t.db, keyring: onlyNew }, rotation.repo2.id, "deepseek"),
    ).toMatchObject({
      apiKey: "sk-rot-a-000000000001",
    });

    const again = await rotateCredentials(t.db, ring2);
    expect(again).toEqual({ rotated: 0, skipped: 0, failed: [] });
  });

  it("new keys stored after the switch are written with the new key and are left alone", async () => {
    const fresh = await createTenant(t.db, "fresh");
    await store(fresh, "deepseek", "sk-fresh-0000000000004", {}, ring2);
    const row = await t.pool.query(
      "select key_version, ciphertext from provider_credentials where installation_id = $1",
      [fresh.installation.id],
    );
    expect(row.rows[0].key_version).toBe(2);
    expect(
      decryptSecret(
        row.rows[0].ciphertext,
        2,
        new Keyring(ring2.current),
        credentialContext({ installationId: fresh.installation.id }, "deepseek"),
      ),
    ).toBe("sk-fresh-0000000000004");
    expect(await rotateCredentials(t.db, ring2)).toEqual({ rotated: 0, skipped: 0, failed: [] });
  });

  it("reports records it cannot read instead of looping or damaging them", async () => {
    const stray = await createTenant(t.db, "stray");
    const key3 = new Keyring({ version: 3, key: randomBytes(32) });
    await store(stray, "deepseek", "sk-stray-0000000000005", {}, key3);
    const before = await t.pool.query(
      "select ciphertext from provider_credentials where installation_id = $1",
      [stray.installation.id],
    );

    const result = await rotateCredentials(t.db, ring2); // ring2 has no version 3
    expect(result.rotated).toBe(0);
    expect(result.failed).toHaveLength(1);

    const after = await t.pool.query(
      "select ciphertext, key_version from provider_credentials where installation_id = $1",
      [stray.installation.id],
    );
    expect(after.rows[0].key_version).toBe(3);
    expect(after.rows[0].ciphertext.equals(before.rows[0].ciphertext)).toBe(true);
  });

  it("does not overwrite a key that was replaced while rotation was running", async () => {
    const racing = await createTenant(t.db, "racing");
    const stored = await store(racing, "deepseek", "sk-race-old-00000000006");
    const { listCredentialsForRotation, replaceCredentialCiphertext } =
      await import("@ai-pr-review/db/system");
    const [candidate] = (await listCredentialsForRotation(t.db, 2, 1000)).filter(
      (c) => c.id === stored.id,
    );

    // A user stores a new key (with the new key version) after rotation read the old record.
    await store(racing, "deepseek", "sk-race-new-00000000007", {}, ring2);
    const swapped = await replaceCredentialCiphertext(
      t.db,
      candidate!.id,
      candidate!.keyVersion,
      Buffer.from("stale"),
      2,
    );
    expect(swapped).toBe(false);

    expect(
      await getDecryptedCredential({ db: t.db, keyring: ring2 }, racing.repo.id, "deepseek"),
    ).toMatchObject({
      apiKey: "sk-race-new-00000000007",
    });
  });
});
