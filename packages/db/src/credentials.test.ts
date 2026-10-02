import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { getProviderCredentialForWorker } from "./system";
import { deleteProviderCredential, listProviderCredentials, putProviderCredential } from "./tenant";
import { InvalidInputError } from "./errors";
import { createTenant, type Tenant } from "./testing/fixtures";
import { createTestDatabase, type TestDatabase } from "./testing/testDb";

let t: TestDatabase;
let A: Tenant;
let B: Tenant;

const MARKER = "CIPHERTEXT-MARKER-0123456789";
const cipher = (s: string) => Buffer.from(`${MARKER}:${s}`);

beforeAll(async () => {
  t = await createTestDatabase();
  A = await createTenant(t.db, "alpha");
  B = await createTenant(t.db, "beta");
}, 30_000);
afterAll(async () => {
  await t.drop();
});

/** True if the marker (as text, hex or base64) appears anywhere in the serialised value. */
function leaks(value: unknown): boolean {
  const json = JSON.stringify(value, (_k, v) => (v instanceof Buffer ? v.toString("hex") : v));
  const raw = Buffer.from(MARKER);
  return (
    json.includes(MARKER) ||
    json.includes(raw.toString("hex")) ||
    json.includes(raw.toString("base64").slice(0, 16))
  );
}

describe("provider credentials: callers see only provider, last4 and metadata", () => {
  it("never returns ciphertext from the tenant-scoped functions", async () => {
    const id = A.installation.id;
    const put = await putProviderCredential(t.db, id, {
      provider: "deepseek",
      ciphertext: cipher("default"),
      keyVersion: 2,
      last4: "9f3a",
      createdBy: A.user.id,
    });
    const listed = await listProviderCredentials(t.db, [id]);

    for (const result of [put, ...listed]) {
      expect(Object.keys(result)).not.toContain("ciphertext");
      expect(leaks(result)).toBe(false);
    }
    expect(put).toEqual({
      id: expect.any(String),
      installationId: id,
      repoId: null,
      provider: "deepseek",
      keyVersion: 2,
      last4: "9f3a",
      createdBy: A.user.id,
      createdAt: expect.any(Date),
    });
  });

  it("stores no plaintext-key column", async () => {
    const { rows } = await t.pool.query(
      "select column_name from information_schema.columns where table_name = 'provider_credentials'",
    );
    const columns = rows.map((r) => r.column_name as string);
    expect(columns).toContain("ciphertext");
    expect(
      columns.filter((c) => /^(api_?key|key|secret|token|plaintext|password)$/.test(c)),
    ).toEqual([]);
  });

  it("replaces the key for the same scope and provider instead of accumulating", async () => {
    const id = B.installation.id;
    const first = await putProviderCredential(t.db, id, {
      provider: "openai",
      ciphertext: cipher("v1"),
      keyVersion: 1,
      last4: "aaaa",
    });
    const second = await putProviderCredential(t.db, id, {
      provider: "openai",
      ciphertext: cipher("v2"),
      keyVersion: 2,
      last4: "bbbb",
    });
    expect(second.id).toBe(first.id);
    const listed = await listProviderCredentials(t.db, [id], { repoId: null });
    expect(listed).toHaveLength(1);
    expect(listed[0]).toMatchObject({ last4: "bbbb", keyVersion: 2 });
    const worker = await getProviderCredentialForWorker(t.db, id, undefined, "openai");
    expect(worker?.ciphertext.toString()).toBe(`${MARKER}:v2`);
  });

  it("keeps the installation default and per-repository overrides separate", async () => {
    const id = A.installation.id;
    await putProviderCredential(t.db, id, {
      repoId: A.repo.id,
      provider: "deepseek",
      ciphertext: cipher("repo-override"),
      keyVersion: 1,
      last4: "rrrr",
    });
    expect(await listProviderCredentials(t.db, [id], { repoId: null })).toHaveLength(1);
    expect(await listProviderCredentials(t.db, [id], { repoId: A.repo.id })).toHaveLength(1);
    expect(await listProviderCredentials(t.db, [id])).toHaveLength(2);
  });

  it("validates input", async () => {
    const base = {
      provider: "anthropic" as const,
      ciphertext: cipher("x"),
      keyVersion: 1,
      last4: "abcd",
    };
    const id = A.installation.id;
    await expect(putProviderCredential(t.db, id, { ...base, last4: "" })).rejects.toBeInstanceOf(
      InvalidInputError,
    );
    await expect(
      putProviderCredential(t.db, id, { ...base, last4: "abcde" }),
    ).rejects.toBeInstanceOf(InvalidInputError);
    await expect(
      putProviderCredential(t.db, id, { ...base, ciphertext: Buffer.alloc(0) }),
    ).rejects.toBeInstanceOf(InvalidInputError);
    await expect(
      putProviderCredential(t.db, id, { ...base, keyVersion: 0 }),
    ).rejects.toBeInstanceOf(InvalidInputError);
  });

  it("deletes by id within the installation only", async () => {
    const id = B.installation.id;
    const made = await putProviderCredential(t.db, id, {
      provider: "anthropic",
      ciphertext: cipher("del"),
      keyVersion: 1,
      last4: "zzzz",
    });
    expect(await deleteProviderCredential(t.db, A.installation.id, made.id)).toBe(false);
    expect(await deleteProviderCredential(t.db, id, made.id)).toBe(true);
    expect(await deleteProviderCredential(t.db, id, made.id)).toBe(false);
    expect(await getProviderCredentialForWorker(t.db, id, undefined, "anthropic")).toBeUndefined();
  });
});

describe("provider credentials: worker-side function", () => {
  it("returns the ciphertext bytes", async () => {
    const got = await getProviderCredentialForWorker(
      t.db,
      A.installation.id,
      undefined,
      "deepseek",
    );
    expect(got).toBeDefined();
    expect(Buffer.isBuffer(got!.ciphertext)).toBe(true);
    expect(got!.ciphertext.toString()).toBe(`${MARKER}:default`);
    expect(got).toMatchObject({ provider: "deepseek", keyVersion: 2, repoId: null });
  });

  it("prefers the repository override and falls back to the installation default", async () => {
    const id = A.installation.id;
    const forRepo = await getProviderCredentialForWorker(t.db, id, A.repo.id, "deepseek");
    expect(forRepo?.ciphertext.toString()).toBe(`${MARKER}:repo-override`);
    expect(forRepo?.repoId).toBe(A.repo.id);
    // The other repository has no override: it gets the installation default.
    const forRepo2 = await getProviderCredentialForWorker(t.db, id, A.repo2.id, "deepseek");
    expect(forRepo2?.ciphertext.toString()).toBe(`${MARKER}:default`);
    // No key for a provider that was never configured.
    expect(await getProviderCredentialForWorker(t.db, id, A.repo.id, "anthropic")).toBeUndefined();
  });

  it("never crosses installations", async () => {
    // B has an openai key and A does not; asking as A (or with A's repository) finds nothing.
    expect(
      await getProviderCredentialForWorker(t.db, A.installation.id, undefined, "openai"),
    ).toBeUndefined();
    expect(
      await getProviderCredentialForWorker(t.db, A.installation.id, B.repo.id, "openai"),
    ).toBeUndefined();
    expect(
      await getProviderCredentialForWorker(t.db, B.installation.id, A.repo.id, "deepseek"),
    ).toBeUndefined();
    expect(await getProviderCredentialForWorker(t.db, "nope", undefined, "openai")).toBeUndefined();
  });
});
