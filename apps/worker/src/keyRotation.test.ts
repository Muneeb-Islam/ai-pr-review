// The key rotation and emergency revocation procedures of docs/operations.md, run for real (PL-10, AC-18): the scripts as
// an operator runs them, in a child process with only environment variables, against a real database, with reviews
// started before, during and after to show that nothing stops working and that the old key ends up useless.
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { Keyring } from "@ai-pr-review/core";
import {
  createTenant,
  createTestDatabase,
  type Tenant,
  type TestDatabase,
} from "@ai-pr-review/db/testing";
import { getRunById } from "@ai-pr-review/db/system";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { buildRig, configure, queuedRun, storeKey } from "./testing";

// Each step starts a child process (the script, as an operator would run it): slow when the machine is busy.
vi.setConfig({ testTimeout: 120_000 });

let t: TestDatabase;
let tenant: Tenant;

const KEY = ["sk-rotation", "e2e", "KeyValue0123456789"].join("-");
const key1 = randomBytes(32);
const key2 = randomBytes(32);
const ring1 = new Keyring({ version: 1, key: key1 });
/** What the operator configures after step 2: the new key is current, the old one is still readable. */
const ring2WithPrevious = new Keyring({ version: 2, key: key2 }, [{ version: 1, key: key1 }]);
const ring2 = new Keyring({ version: 2, key: key2 });

const tsx = createRequire(import.meta.url).resolve("tsx/cli");
const worker = fileURLToPath(new URL("..", import.meta.url));

/** Runs one of the operator scripts the way `npm run` would: a child process that sees only these variables. */
function script(name: string, env: Record<string, string>, args: string[] = []) {
  try {
    const stdout = execFileSync(process.execPath, [tsx, `scripts/${name}`, ...args], {
      cwd: worker,
      env: { PATH: process.env["PATH"] ?? "", ...env },
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 60_000,
    });
    return { code: 0, stdout, stderr: "" };
  } catch (err) {
    const e = err as { status?: number; stdout?: string; stderr?: string };
    return { code: e.status ?? 1, stdout: e.stdout ?? "", stderr: e.stderr ?? "" };
  }
}

beforeAll(async () => {
  t = await createTestDatabase();
  tenant = await createTenant(t.db, "rotation-e2e");
  await configure(t, tenant);
  await storeKey(t, tenant, "deepseek", KEY, ring1);
}, 60_000);
afterAll(async () => {
  await t.drop();
});

/** One review with the given keyring; returns what the provider was constructed with, and the run's final state. */
async function review(keyring: Keyring) {
  const run = await queuedRun(t, tenant, Math.floor(Math.random() * 1_000_000) + 1);
  const rig = buildRig(t, { deps: { keyring } });
  await rig.processor.process(run.id);
  return { rig, run: (await getRunById(t.db, run.id))! };
}

const keyVersions = async () =>
  (await t.pool.query("select key_version from provider_credentials")).rows.map(
    (r) => r.key_version,
  );

describe("rotating ENCRYPTION_KEY, step by step", () => {
  it("1. before: a review uses the stored key", async () => {
    const { rig, run } = await review(ring1);
    expect(rig.providerCalls.map((c) => c.apiKey)).toEqual([KEY]);
    expect(run.status).toBe("completed");
    expect(await keyVersions()).toEqual([1]);
  });

  it("2. new key current, old key as previous: reviews keep working, reading the old record with the previous key", async () => {
    const { rig, run } = await review(ring2WithPrevious);
    expect(rig.providerCalls.map((c) => c.apiKey)).toEqual([KEY]);
    expect(run.status).toBe("completed");
    // Nothing was re-wrapped yet: that is what the script is for.
    expect(await keyVersions()).toEqual([1]);
  });

  it("2b. a key stored now is written with the new key, and the old key cannot read it", async () => {
    const other = await createTenant(t.db, "rotation-e2e-new");
    await configure(t, other);
    await storeKey(t, other, "deepseek", "sk-rotation-e2e-newer-0123456789", ring2WithPrevious);
    const { rows } = await t.pool.query(
      "select key_version from provider_credentials where installation_id = $1",
      [other.installation.id],
    );
    expect(rows[0].key_version).toBe(2);
    await t.pool.query("delete from provider_credentials where installation_id = $1", [
      other.installation.id,
    ]);
  });

  it("3. the rotate script, with only environment variables, re-wraps every record and says so", async () => {
    const run = script("rotate-credentials.ts", {
      DATABASE_URL: t.url,
      ENCRYPTION_KEY: key2.toString("base64"),
      ENCRYPTION_KEY_VERSION: "2",
      ENCRYPTION_KEY_PREVIOUS: key1.toString("base64"),
      ENCRYPTION_KEY_PREVIOUS_VERSION: "1",
    });
    expect(run.code, run.stderr).toBe(0);
    expect(run.stdout).toContain("key version 2: 1 rotated, 0 already current, 0 failed");
    // Neither key appears in what the script printed.
    expect(run.stdout + run.stderr).not.toContain(key1.toString("base64"));
    expect(run.stdout + run.stderr).not.toContain(key2.toString("base64"));
    expect(await keyVersions()).toEqual([2]);
  });

  it("3b. a second run has nothing left to do", async () => {
    const run = script("rotate-credentials.ts", {
      DATABASE_URL: t.url,
      ENCRYPTION_KEY: key2.toString("base64"),
      ENCRYPTION_KEY_VERSION: "2",
      ENCRYPTION_KEY_PREVIOUS: key1.toString("base64"),
      ENCRYPTION_KEY_PREVIOUS_VERSION: "1",
    });
    expect(run.code).toBe(0);
    expect(run.stdout).toContain("0 rotated, 0 already current, 0 failed");
  });

  it("4. previous key removed: reviews still work with the new key alone", async () => {
    const { rig, run } = await review(ring2);
    expect(rig.providerCalls.map((c) => c.apiKey)).toEqual([KEY]);
    expect(run.status).toBe("completed");
  });

  it("5. the old key is now useless: a process still holding only it cannot read the stored key", async () => {
    const { rig, run } = await review(ring1);
    expect(rig.providerCalls).toEqual([]);
    expect(run.status).toBe("failed");
    expect(run.statusReason).toContain("could not be read");
    expect(JSON.stringify(run)).not.toContain(KEY);
  });

  it("the script fails clearly, without echoing a key, when the configuration is wrong", async () => {
    const run = script("rotate-credentials.ts", {
      DATABASE_URL: t.url,
      ENCRYPTION_KEY: "not-a-valid-key-but-secret-looking",
    });
    expect(run.code).toBe(1);
    expect(run.stderr).toContain("ENCRYPTION_KEY");
    expect(run.stderr).not.toContain("not-a-valid-key-but-secret-looking");
  });
});

describe("emergency revocation", () => {
  it("revoking one installation's keys stops its runs from using them, and leaves other installations alone", async () => {
    const other = await createTenant(t.db, "revoke-other");
    await configure(t, other);
    await storeKey(t, other, "deepseek", "sk-rotation-e2e-other-0123456789", ring2);

    const out = script("revoke-credentials.ts", { DATABASE_URL: t.url }, [
      "--installation",
      String(tenant.installation.githubInstallationId),
    ]);
    expect(out.code, out.stderr).toBe(0);
    expect(out.stdout).toContain("Deleted 1 stored provider key(s)");

    const { rig, run } = await review(ring2);
    expect(rig.providerCalls).toEqual([]);
    expect(run.status).toBe("failed");
    expect(run.statusReason).toContain("No API key is stored for deepseek");

    const left = await t.pool.query("select installation_id from provider_credentials");
    expect(left.rows.map((r) => r.installation_id)).toEqual([other.installation.id]);
  });

  it("--all deletes every stored key", async () => {
    const out = script("revoke-credentials.ts", { DATABASE_URL: t.url }, ["--all"]);
    expect(out.code).toBe(0);
    expect(out.stdout).toContain("Deleted 1 stored provider key(s)");
    expect(
      (await t.pool.query("select count(*)::int as n from provider_credentials")).rows[0].n,
    ).toBe(0);
  });

  it("refuses to guess: no arguments, a wrong flag or a bad id change nothing", async () => {
    await storeKey(t, tenant, "deepseek", KEY, ring2);
    for (const args of [
      [],
      ["--everything"],
      ["--installation"],
      ["--installation", "abc"],
      ["--installation", "-1"],
    ]) {
      const out = script("revoke-credentials.ts", { DATABASE_URL: t.url }, args);
      expect(out.code, args.join(" ")).toBe(1);
      expect(out.stderr).toContain("Usage");
    }
    expect(
      (await t.pool.query("select count(*)::int as n from provider_credentials")).rows[0].n,
    ).toBe(1);
  });
});
